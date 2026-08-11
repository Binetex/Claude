import "server-only";
/**
 * Brevo API key — СВОЙ У КАЖДОГО МАГАЗИНА. Общего ключа на аккаунт нет: у магазинов разные
 * аккаунты Brevo, и один ключ на всех означал бы, что письма одного магазина уходят из чужого
 * аккаунта. Одно и то же значение у нескольких магазинов допустимо — это просто их выбор.
 *
 * Хранится зашифрованным в IntegrationSecret (provider="BREVO", kind="api_key", siteId=магазин) —
 * переиспользует secretBox/шаблон, уже работающий для QUO webhook signing secrets. Наружу —
 * только маска, никогда полное значение.
 *
 * env BREVO_API_KEY больше НЕ участвует: «резервный ключ» здесь опаснее отсутствия ключа —
 * молча отправить письмо из чужого аккаунта хуже, чем не отправить и показать причину.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { encryptSecret, decryptSecret, maskSecret, isCredentialCryptoConfigured } from "@/lib/crypto/secretBox";
import { verifyBrevoApiKey } from "./brevo";

const PROVIDER = "BREVO";
const KIND = "api_key";

async function getActiveRow(prisma: PrismaClient, siteId: string) {
  return prisma.integrationSecret.findFirst({
    where: { provider: PROVIDER, kind: KIND, active: true, siteId },
    orderBy: { createdAt: "desc" },
  });
}

/** Ключ ЭТОГО магазина для реального вызова Brevo API. ТОЛЬКО на сервере. */
export async function resolveBrevoApiKey(prisma: PrismaClient, siteId: string): Promise<string | null> {
  const row = await getActiveRow(prisma, siteId);
  if (!row) return null;
  try {
    return decryptSecret(row.encryptedValue);
  } catch {
    // Битый шифр (например, ротация ключа шифрования) — не роняем приложение: считаем, что
    // ключа нет. Чужой ключ вместо него не подставляем.
    return null;
  }
}

/**
 * Задан ли ключ у магазина. Намеренно проверяется НАЛИЧИЕ строки, а не расшифровка: «владелец не
 * ввёл ключ» и «на сервере сломано шифрование» — разные беды, и вторая не должна выглядеть как
 * первая. Нерасшифруемый ключ всплывёт на отправке отдельной ошибкой, а не молчаливым
 * «Email не настроен».
 */
export async function isBrevoConfiguredForSite(prisma: PrismaClient, siteId: string): Promise<boolean> {
  return (await getActiveRow(prisma, siteId)) !== null;
}

export type BrevoAccountView = {
  configured: boolean;
  maskedSuffix: string | null;
  cryptoConfigured: boolean;
  connStatus: string | null;
  verifiedAt: string | null;
  accountEmail: string | null;
  errorSafe: string | null;
};

/** Полное состояние панели магазина: маска, статус последней проверки. Без значений. */
export async function getBrevoAccountView(prisma: PrismaClient, siteId: string): Promise<BrevoAccountView> {
  const [row, status] = await Promise.all([
    getActiveRow(prisma, siteId),
    prisma.brevoAccountStatus.findUnique({ where: { siteId } }),
  ]);
  return {
    configured: !!row,
    maskedSuffix: row?.maskedSuffix ?? null,
    cryptoConfigured: isCredentialCryptoConfigured(),
    connStatus: status?.connStatus ?? null,
    verifiedAt: status?.verifiedAt ? status.verifiedAt.toISOString() : null,
    accountEmail: status?.accountEmail ?? null,
    errorSafe: status?.errorSafe ?? null,
  };
}

export type SaveKeyResult = { ok: true; maskedSuffix: string } | { ok: false; error: string };

/** Сохраняет новый ключ (заменяет предыдущий из БД) и сбрасывает статус проверки — новый ключ ещё не проверен. */
export async function saveBrevoApiKey(prisma: PrismaClient, siteId: string, raw: string): Promise<SaveKeyResult> {
  const key = (raw ?? "").trim();
  if (!key) return { ok: false, error: "Пустой API key." };
  if (key.length < 20) return { ok: false, error: "Слишком короткий API key." };
  if (!isCredentialCryptoConfigured()) {
    return { ok: false, error: "Шифрование не настроено на сервере (CREDENTIALS_ENCRYPTION_KEY)." };
  }

  const maskedSuffix = maskSecret(key);
  await prisma.$transaction([
    prisma.integrationSecret.deleteMany({ where: { provider: PROVIDER, kind: KIND, siteId } }),
    prisma.integrationSecret.create({
      data: { provider: PROVIDER, kind: KIND, encryptedValue: encryptSecret(key), maskedSuffix, active: true, siteId },
    }),
    prisma.brevoAccountStatus.deleteMany({ where: { siteId } }),
  ]);
  return { ok: true, maskedSuffix };
}

/** Удаляет ключ магазина. После этого Email этого магазина не отправляется (запасного нет). */
export async function clearBrevoApiKey(prisma: PrismaClient, siteId: string): Promise<void> {
  await prisma.$transaction([
    prisma.integrationSecret.deleteMany({ where: { provider: PROVIDER, kind: KIND, siteId } }),
    prisma.brevoAccountStatus.deleteMany({ where: { siteId } }),
  ]);
}

export type VerifyResult = { ok: true; accountEmail: string | null } | { ok: false; error: string };

/** Реальная проверка подключения (GET /v3/account) + запись статуса, переживающего refresh. */
export async function verifyAndRecordBrevoConnection(prisma: PrismaClient, siteId: string): Promise<VerifyResult> {
  const key = await resolveBrevoApiKey(prisma, siteId);
  if (!key) {
    await recordStatus(prisma, siteId, { connStatus: "ERROR", accountEmail: null, errorSafe: "API key не задан." });
    return { ok: false, error: "API key не задан." };
  }

  const res = await verifyBrevoApiKey(key);
  if (res.ok) {
    await recordStatus(prisma, siteId, { connStatus: "CONNECTED", accountEmail: res.accountEmail, errorSafe: null });
    return { ok: true, accountEmail: res.accountEmail };
  }
  await recordStatus(prisma, siteId, { connStatus: "ERROR", accountEmail: null, errorSafe: res.safeError });
  return { ok: false, error: res.safeError };
}

async function recordStatus(
  prisma: PrismaClient,
  siteId: string,
  data: { connStatus: string; accountEmail: string | null; errorSafe: string | null }
): Promise<void> {
  const payload = { ...data, verifiedAt: new Date() };
  await prisma.brevoAccountStatus.upsert({
    where: { siteId },
    create: { siteId, ...payload },
    update: payload,
  });
}
