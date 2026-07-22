import "server-only";
import crypto from "crypto";

/**
 * Authenticated-encryption сервис для credentials (Client Secret, access token и т.п.).
 *
 * AES-256-GCM. Свойства:
 *  - отдельный случайный IV (12 байт) на КАЖДОЕ значение;
 *  - версия ключа хранится в шифртексте → поддержка ротации ключа шифрования;
 *  - GCM authentication tag ловит любую подмену шифртекста;
 *  - маска (`maskSecret`) вычисляется из открытого текста в момент сохранения и хранится
 *    отдельной колонкой, чтобы обычный рендер UI НЕ требовал расшифровки.
 *
 * Формат хранения: `${keyVersion}:${ivB64}:${tagB64}:${cipherB64}`.
 * Ключи — только из env, никогда не в git и не в коде. НЕ логировать открытые значения.
 */

const ALGO = "aes-256-gcm";
const IV_BYTES = 12;

type KeyRing = { keys: Map<string, Buffer>; activeId: string };

function decodeKey(b64: string, id: string): Buffer {
  const key = Buffer.from(b64, "base64");
  if (key.length !== 32) {
    throw new Error(`Ключ шифрования '${id}' должен быть 32 байта (base64), получено ${key.length}.`);
  }
  return key;
}

/**
 * Загружает связку ключей из env (парсится при каждом вызове — стоимость ничтожна,
 * зато безопасно к смене env в тестах). Варианты:
 *  1) РОТАЦИЯ: CREDENTIALS_ENCRYPTION_KEYS = '{"1":"<b64>","2":"<b64>"}' + CREDENTIALS_ENCRYPTION_ACTIVE_KEY="2"
 *     (шифруем активным, расшифровываем любым — версия ключа хранится в самом шифртексте);
 *  2) ПРОСТОЙ: CREDENTIALS_ENCRYPTION_KEY = '<b64>' (единственный ключ версии "1").
 *     Для ротации переходите на вариант 1 (добавьте новый ключ и переключите active).
 */
function loadKeyRing(): KeyRing {
  const multi = process.env.CREDENTIALS_ENCRYPTION_KEYS;
  if (multi) {
    let parsed: Record<string, string>;
    try {
      parsed = JSON.parse(multi) as Record<string, string>;
    } catch {
      throw new Error("CREDENTIALS_ENCRYPTION_KEYS должен быть JSON вида {\"1\":\"<base64>\"}.");
    }
    const keys = new Map<string, Buffer>();
    for (const [id, b64] of Object.entries(parsed)) keys.set(id, decodeKey(b64, id));
    if (keys.size === 0) throw new Error("CREDENTIALS_ENCRYPTION_KEYS пуст.");
    const activeId = process.env.CREDENTIALS_ENCRYPTION_ACTIVE_KEY ?? [...keys.keys()].sort().at(-1)!;
    if (!keys.has(activeId)) throw new Error(`Активный ключ '${activeId}' отсутствует в CREDENTIALS_ENCRYPTION_KEYS.`);
    return { keys, activeId };
  }

  const single = process.env.CREDENTIALS_ENCRYPTION_KEY;
  if (single) {
    return { keys: new Map<string, Buffer>([["1", decodeKey(single, "1")]]), activeId: "1" };
  }

  throw new Error(
    "Не задан ключ шифрования credentials: установите CREDENTIALS_ENCRYPTION_KEY (32 байта base64) или CREDENTIALS_ENCRYPTION_KEYS."
  );
}

/** Шифрует секрет. Возвращает самодостаточную строку (версия ключа + IV + tag + шифртекст). */
export function encryptSecret(plaintext: string): string {
  const { keys, activeId } = loadKeyRing();
  const key = keys.get(activeId)!;
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${activeId}:${iv.toString("base64")}:${tag.toString("base64")}:${ct.toString("base64")}`;
}

/** Расшифровывает секрет. Бросает при подмене (GCM auth) или неизвестной версии ключа. */
export function decryptSecret(payload: string): string {
  const { keys } = loadKeyRing();
  const parts = payload.split(":");
  if (parts.length !== 4) throw new Error("Некорректный формат зашифрованного значения.");
  const [version, ivB64, tagB64, ctB64] = parts;
  const key = keys.get(version);
  if (!key) throw new Error(`Нет ключа шифрования версии '${version}' (ротация?).`);
  const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64")), decipher.final()]).toString("utf8");
}

/**
 * Маска для UI: последние `visible` символов, остальное — звёздочки. Считается из открытого
 * текста в момент сохранения и хранится отдельно — обычный рендер карточки НЕ расшифровывает.
 */
export function maskSecret(plaintext: string, visible = 4): string {
  if (!plaintext) return "";
  if (plaintext.length <= visible) return "*".repeat(8);
  return "*".repeat(8) + plaintext.slice(-visible);
}

/** true, если сервис сконфигурирован (есть валидный ключ). Для health/диагностики. */
export function isCredentialCryptoConfigured(): boolean {
  try {
    loadKeyRing();
    return true;
  } catch {
    return false;
  }
}
