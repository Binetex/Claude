import { describe, it, expect, beforeEach, afterEach } from "vitest";
import crypto from "crypto";
import { encryptSecret, decryptSecret, maskSecret, isCredentialCryptoConfigured } from "./secretBox";

const KEY1 = crypto.randomBytes(32).toString("base64");
const KEY2 = crypto.randomBytes(32).toString("base64");

const origEnv = { ...process.env };
function clearKeys() {
  delete process.env.CREDENTIALS_ENCRYPTION_KEY;
  delete process.env.CREDENTIALS_ENCRYPTION_KEY_PREVIOUS;
  delete process.env.CREDENTIALS_ENCRYPTION_KEYS;
  delete process.env.CREDENTIALS_ENCRYPTION_ACTIVE_KEY;
}

beforeEach(() => clearKeys());
afterEach(() => {
  clearKeys();
  Object.assign(process.env, origEnv);
});

describe("secretBox — AES-256-GCM шифрование credentials", () => {
  it("roundtrip: расшифровка возвращает исходное значение", () => {
    process.env.CREDENTIALS_ENCRYPTION_KEY = KEY1;
    const secret = "shpat_super_secret_token_12345";
    const enc = encryptSecret(secret);
    expect(enc).not.toContain(secret); // шифртекст не содержит открытого значения
    expect(decryptSecret(enc)).toBe(secret);
  });

  it("уникальный IV: два шифрования одного значения различаются", () => {
    process.env.CREDENTIALS_ENCRYPTION_KEY = KEY1;
    const a = encryptSecret("same-value");
    const b = encryptSecret("same-value");
    expect(a).not.toBe(b);
    expect(decryptSecret(a)).toBe("same-value");
    expect(decryptSecret(b)).toBe("same-value");
  });

  it("детекция подмены: изменённый шифртекст не расшифровывается (GCM tag)", () => {
    process.env.CREDENTIALS_ENCRYPTION_KEY = KEY1;
    const enc = encryptSecret("tamper-me");
    const parts = enc.split(":");
    const ct = Buffer.from(parts[3], "base64");
    ct[0] = ct[0] ^ 0xff; // портим первый байт шифртекста
    const tampered = `${parts[0]}:${parts[1]}:${parts[2]}:${ct.toString("base64")}`;
    expect(() => decryptSecret(tampered)).toThrow();
  });

  it("формат содержит версию ключа", () => {
    process.env.CREDENTIALS_ENCRYPTION_KEY = KEY1;
    expect(encryptSecret("x").startsWith("1:")).toBe(true);
  });
});

describe("secretBox — ротация ключа шифрования", () => {
  it("значение, зашифрованное старым ключом, читается после смены активного ключа", () => {
    // Шифруем ключом версии 1.
    process.env.CREDENTIALS_ENCRYPTION_KEYS = JSON.stringify({ "1": KEY1 });
    process.env.CREDENTIALS_ENCRYPTION_ACTIVE_KEY = "1";
    const enc = encryptSecret("rotate-me");

    // Ротация: добавили ключ 2 и сделали активным; ключ 1 остаётся для расшифровки.
    process.env.CREDENTIALS_ENCRYPTION_KEYS = JSON.stringify({ "1": KEY1, "2": KEY2 });
    process.env.CREDENTIALS_ENCRYPTION_ACTIVE_KEY = "2";
    expect(decryptSecret(enc)).toBe("rotate-me"); // старое значение всё ещё читается
    expect(encryptSecret("new").startsWith("2:")).toBe(true); // новые шифруются активным ключом
  });

  it("бросает, если ключ нужной версии отсутствует", () => {
    process.env.CREDENTIALS_ENCRYPTION_KEYS = JSON.stringify({ "1": KEY1 });
    const enc = encryptSecret("v1");
    process.env.CREDENTIALS_ENCRYPTION_KEYS = JSON.stringify({ "2": KEY2 }); // ключ 1 убрали
    process.env.CREDENTIALS_ENCRYPTION_ACTIVE_KEY = "2";
    expect(() => decryptSecret(enc)).toThrow(/версии '1'/);
  });
});

describe("secretBox — маска и конфигурация", () => {
  it("maskSecret скрывает всё, кроме последних символов", () => {
    expect(maskSecret("shpat_abcd1234", 4)).toBe("*".repeat(8) + "1234");
    expect(maskSecret("ab")).toBe("*".repeat(8)); // короткое — целиком скрыто
    expect(maskSecret("")).toBe("");
  });

  it("isCredentialCryptoConfigured отражает наличие ключа", () => {
    expect(isCredentialCryptoConfigured()).toBe(false);
    process.env.CREDENTIALS_ENCRYPTION_KEY = KEY1;
    expect(isCredentialCryptoConfigured()).toBe(true);
  });

  it("бросает при отсутствии ключа", () => {
    expect(() => encryptSecret("x")).toThrow(/ключ шифрования/i);
  });

  it("бросает при ключе неверной длины", () => {
    process.env.CREDENTIALS_ENCRYPTION_KEY = Buffer.from("short").toString("base64");
    expect(() => encryptSecret("x")).toThrow(/32 байта/);
  });
});
