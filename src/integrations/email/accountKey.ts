import "server-only";
/**
 * Общий Brevo API key (один аккаунт на все магазины, НЕ per-Site). Хранится зашифрованным в
 * IntegrationSecret (provider="BREVO", kind="api_key") — переиспользует secretBox/шаблон, уже
 * работающий для QUO webhook signing secrets. Наружу — только маска, никогда полное значение.
 *
 * Приоритет источника: ключ из БД (если есть) важнее env BREVO_API_KEY. Это позволяет владельцу
 * вставить и заменить ключ через UI без доступа к серверу, при этом env остаётся резервным
 * вариантом (например, для локальной разработки).
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { encryptSecret, decryptSecret, maskSecret, isCredentialCryptoConfigured } from "@/lib/crypto/secretBox";
import { verifyBrevoApiKey } from "./brevo";

const PROVIDER = "BREVO";
const KIND = "api_key";

async function getActiveRow(prisma: PrismaClient) {
  return prisma.integrationSecret.findFirst({
    where: { provider: PROVIDER, kind: KIND, active: true },
    orderBy: { createdAt: "desc" },
  });
}

/** Ключ для реального вызова Brevo API. ТОЛЬКО на сервере. БД приоритетнее env. */
export async function resolveBrevoApiKey(prisma: PrismaClient): Promise<string | null> {
  const row = await getActiveRow(prisma);
  if (row) {
    try {
      return decryptSecret(row.encryptedValue);
    } catch {
      // Битый шифр (например, ротация ключа шифрования) — не роняем приложение, просто считаем,
      // что ключа из БД нет, и пробуем env.
    }
  }
  return process.env.BREVO_API_KEY?.trim() || null;
}

export async function isBrevoConfiguredAnywhere(prisma: PrismaClient): Promise<boolean> {
  return (await resolveBrevoApiKey(prisma)) !== null;
}

export type BrevoAccountView = {
  configured: boolean;
  source: "db" | "env" | null;
  maskedSuffix: string | null;
  cryptoConfigured: boolean;
  connStatus: string | null;
  verifiedAt: string | null;
  accountEmail: string | null;
  errorSafe: string | null;
};

/** Полное состояние для панели: маска, источник, статус последней проверки. Без значений. */
export async function getBrevoAccountView(prisma: PrismaClient): Promise<BrevoAccountView> {
  const [row, status] = await Promise.all([
    getActiveRow(prisma),
    prisma.brevoAccountStatus.findFirst({ orderBy: { createdAt: "desc" } }),
  ]);
  const envConfigured = !!process.env.BREVO_API_KEY?.trim();
  return {
    configured: !!row || envConfigured,
    source: row ? "db" : envConfigured ? "env" : null,
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
export async function saveBrevoApiKey(prisma: PrismaClient, raw: string): Promise<SaveKeyResult> {
  const key = (raw ?? "").trim();
  if (!key) return { ok: false, error: "Пустой API key." };
  if (key.length < 20) return { ok: false, error: "Слишком короткий API key." };
  if (!isCredentialCryptoConfigured()) {
    return { ok: false, error: "Шифрование не настроено на сервере (CREDENTIALS_ENCRYPTION_KEY)." };
  }

  const maskedSuffix = maskSecret(key);
  await prisma.$transaction([
    prisma.integrationSecret.deleteMany({ where: { provider: PROVIDER, kind: KIND } }),
    prisma.integrationSecret.create({
      data: { provider: PROVIDER, kind: KIND, encryptedValue: encryptSecret(key), maskedSuffix, active: true },
    }),
    prisma.brevoAccountStatus.deleteMany({}),
  ]);
  return { ok: true, maskedSuffix };
}

/** Удаляет ключ из БД (после этого действует только env, если задан). */
export async function clearBrevoApiKey(prisma: PrismaClient): Promise<void> {
  await prisma.$transaction([
    prisma.integrationSecret.deleteMany({ where: { provider: PROVIDER, kind: KIND } }),
    prisma.brevoAccountStatus.deleteMany({}),
  ]);
}

export type VerifyResult = { ok: true; accountEmail: string | null } | { ok: false; error: string };

/** Реальная проверка подключения (GET /v3/account) + запись статуса, переживающего refresh. */
export async function verifyAndRecordBrevoConnection(prisma: PrismaClient): Promise<VerifyResult> {
  const key = await resolveBrevoApiKey(prisma);
  if (!key) {
    await recordStatus(prisma, { connStatus: "ERROR", accountEmail: null, errorSafe: "API key не задан." });
    return { ok: false, error: "API key не задан." };
  }

  const res = await verifyBrevoApiKey(key);
  if (res.ok) {
    await recordStatus(prisma, { connStatus: "CONNECTED", accountEmail: res.accountEmail, errorSafe: null });
    return { ok: true, accountEmail: res.accountEmail };
  }
  await recordStatus(prisma, { connStatus: "ERROR", accountEmail: null, errorSafe: res.safeError });
  return { ok: false, error: res.safeError };
}

async function recordStatus(
  prisma: PrismaClient,
  data: { connStatus: string; accountEmail: string | null; errorSafe: string | null }
): Promise<void> {
  const existing = await prisma.brevoAccountStatus.findFirst({ orderBy: { createdAt: "desc" } });
  const payload = { ...data, verifiedAt: new Date() };
  if (existing) {
    await prisma.brevoAccountStatus.update({ where: { id: existing.id }, data: payload });
  } else {
    await prisma.brevoAccountStatus.create({ data: payload });
  }
}
