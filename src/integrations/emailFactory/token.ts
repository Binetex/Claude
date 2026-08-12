import "server-only";
/**
 * Токен Email Factory (`mail.binetex.com`) — ОДИН НА АККАУНТ, без привязки к магазину: токен и так
 * видит все домены аккаунта, поэтому свой у каждого Site был бы одним и тем же значением в пяти
 * местах. Хранится в `IntegrationSecret` с `siteId = null` — тем же способом, что общая подпись
 * вебхуков QUO. Своей таблицы не заводим: миграция ради одной строки не нужна.
 *
 * Наружу отдаётся ТОЛЬКО маска. Полное значение не попадает ни в браузер, ни в логи, ни в ответы
 * server actions.
 *
 * Хранение повторяет `integrations/email/accountKey.ts` (ключ Brevo) буква в букву — замена в
 * транзакции и физическое удаление. Это не вкусовщина: у секретов оба свойства смысловые, см.
 * комментарии ниже.
 *
 * Здесь только хранение. Ни отправки писем, ни вебхуков, ни канала автоматизаций — по решению
 * владельца Email Factory отвечает исключительно за ручную переписку, а транзакционные письма
 * остаются на Brevo. Смешивать нельзя: одно письмо ушло бы дважды с двух разных адресов.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { encryptSecret, decryptSecret, maskSecret, isCredentialCryptoConfigured } from "@/lib/crypto/secretBox";

const PROVIDER = "EMAIL_FACTORY";
const KIND = "api_token";

/** Базовый адрес API. Константой: настройка, которую меняют раз в жизни, экрана не заслуживает. */
export const EMAIL_FACTORY_BASE_URL = "https://mail.binetex.com";

/** Короче этого токена у Email Factory не бывает — отсекаем обрезок, вставленный по ошибке. */
const MIN_TOKEN_LENGTH = 20;

async function getActiveRow(prisma: PrismaClient) {
  return prisma.integrationSecret.findFirst({
    where: { provider: PROVIDER, kind: KIND, active: true, siteId: null },
    orderBy: { createdAt: "desc" },
  });
}

/** Токен для реального вызова API. ТОЛЬКО на сервере, наружу не отдавать. */
export async function resolveEmailFactoryToken(prisma: PrismaClient): Promise<string | null> {
  const row = await getActiveRow(prisma);
  if (!row) return null;
  try {
    return decryptSecret(row.encryptedValue);
  } catch {
    // Битый шифр (например, ротация ключа шифрования) — считаем, что токена нет.
    return null;
  }
}

export type EmailFactoryView = {
  configured: boolean;
  maskedSuffix: string | null;
  cryptoConfigured: boolean;
  savedAt: string | null;
};

export async function loadEmailFactoryView(prisma: PrismaClient): Promise<EmailFactoryView> {
  const row = await getActiveRow(prisma);
  return {
    // Проверяется НАЛИЧИЕ строки, а не расшифровка: «токен не введён» и «на сервере сломано
    // шифрование» — разные беды, и вторая не должна выглядеть как первая.
    configured: row !== null,
    maskedSuffix: row?.maskedSuffix ?? null,
    cryptoConfigured: isCredentialCryptoConfigured(),
    savedAt: row?.updatedAt.toISOString() ?? null,
  };
}

export async function saveEmailFactoryToken(
  prisma: PrismaClient,
  raw: string
): Promise<{ ok: true } | { error: string }> {
  const token = (raw ?? "").trim();
  if (!token) return { error: "Токен пустой." };
  // Обрезок буфера обмена сохранился бы как полноценный токен, страница показала бы зелёное
  // «токен задан», и ошибка всплыла бы только при первом вызове API — когда связь с действием
  // уже потеряна.
  if (token.length < MIN_TOKEN_LENGTH) return { error: "Слишком короткий токен." };
  if (!isCredentialCryptoConfigured()) {
    return { error: "Шифрование секретов не настроено на сервере (CREDENTIALS_ENCRYPTION_KEY)." };
  }

  // Шифруем ДО транзакции: сбой шифрования не должен оставить аккаунт без старого токена.
  const encryptedValue = encryptSecret(token);
  const maskedSuffix = maskSecret(token);

  // Удаление и вставка — ОДНОЙ транзакцией. Двумя запросами подряд сбой на втором оставлял бы
  // ноль активных токенов: старый уже погашен, новый не создан, а на экране «токена нет».
  //
  // Именно УДАЛЕНИЕ, а не флаг `active = false`: строка с расшифровываемым значением, пережившая
  // замену, попадёт в любой дамп базы и в бэкапы. Отозванный токен не должен продолжать где-то
  // лежать. История подключений тут не нужна — это не журнал, а один действующий секрет.
  await prisma.$transaction([
    prisma.integrationSecret.deleteMany({ where: { provider: PROVIDER, kind: KIND, siteId: null } }),
    prisma.integrationSecret.create({
      data: { provider: PROVIDER, kind: KIND, siteId: null, encryptedValue, maskedSuffix, active: true },
    }),
  ]);
  return { ok: true };
}

/** Полное удаление: владелец жмёт «Удалить», чтобы отозвать доступ, а не спрятать его из списка. */
export async function clearEmailFactoryToken(prisma: PrismaClient): Promise<{ ok: true }> {
  await prisma.integrationSecret.deleteMany({ where: { provider: PROVIDER, kind: KIND, siteId: null } });
  return { ok: true };
}
