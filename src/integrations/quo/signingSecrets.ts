import type { PrismaClient } from "@/generated/prisma/client";
import { encryptSecret, decryptSecret, maskSecret, isCredentialCryptoConfigured } from "@/lib/crypto/secretBox";

/**
 * QUO webhook signing secrets в зашифрованном виде (модель IntegrationSecret). Значение шифруется
 * AES-256-GCM (secretBox) и НИКОГДА не отдаётся в браузер — наружу только маска. Проверка подписи
 * вебхука использует объединение env (QUO_WEBHOOK_SIGNING_KEYS) + активных DB-секретов.
 */
const PROVIDER = "QUO";
const KIND = "webhook_signing_secret";

export type MaskedSecret = { id: string; maskedSuffix: string; createdAt: Date };

export async function listQuoSigningSecretsMasked(prisma: PrismaClient): Promise<MaskedSecret[]> {
  return prisma.integrationSecret.findMany({
    where: { provider: PROVIDER, kind: KIND, active: true },
    select: { id: true, maskedSuffix: true, createdAt: true },
    orderBy: { createdAt: "desc" },
  });
}

export async function countActiveQuoSigningSecrets(prisma: PrismaClient): Promise<number> {
  return prisma.integrationSecret.count({ where: { provider: PROVIDER, kind: KIND, active: true } });
}

/** Расшифрованные активные секреты — ТОЛЬКО на сервере (проверка подписи вебхука). */
export async function getActiveQuoSigningSecrets(prisma: PrismaClient): Promise<string[]> {
  const rows = await prisma.integrationSecret.findMany({
    where: { provider: PROVIDER, kind: KIND, active: true },
    select: { encryptedValue: true },
  });
  const out: string[] = [];
  for (const r of rows) {
    try { out.push(decryptSecret(r.encryptedValue)); } catch { /* битый шифр — пропускаем, приём не роняем */ }
  }
  return out;
}

export type AddResult = { ok: true; id: string; maskedSuffix: string } | { ok: false; error: string };

export async function addQuoSigningSecret(prisma: PrismaClient, raw: string): Promise<AddResult> {
  const secret = (raw ?? "").trim();
  if (!secret) return { ok: false, error: "Пустой secret." };
  if (secret.length < 8) return { ok: false, error: "Слишком короткий secret (минимум 8 символов)." };
  if (!isCredentialCryptoConfigured()) return { ok: false, error: "Шифрование не настроено на сервере (CREDENTIALS_ENCRYPTION_KEY)." };
  // Дедуп по ЗНАЧЕНИЮ (шифр недетерминирован → нельзя сравнивать ciphertext).
  const existing = await getActiveQuoSigningSecrets(prisma);
  if (existing.includes(secret)) return { ok: false, error: "Такой secret уже добавлен." };
  const row = await prisma.integrationSecret.create({
    data: { provider: PROVIDER, kind: KIND, encryptedValue: encryptSecret(secret), maskedSuffix: maskSecret(secret), active: true },
    select: { id: true, maskedSuffix: true },
  });
  return { ok: true, id: row.id, maskedSuffix: row.maskedSuffix };
}

/** Полное удаление строки — секрет физически исчезает из БД. */
export async function removeQuoSigningSecret(prisma: PrismaClient, id: string): Promise<{ ok: boolean; maskedSuffix?: string }> {
  const row = await prisma.integrationSecret.findFirst({ where: { id, provider: PROVIDER, kind: KIND }, select: { maskedSuffix: true } });
  if (!row) return { ok: false };
  await prisma.integrationSecret.delete({ where: { id } });
  return { ok: true, maskedSuffix: row.maskedSuffix };
}
