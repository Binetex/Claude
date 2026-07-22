"use server";
import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/rbac";
import { prisma } from "@/lib/db";
import { getQuoSigningKeys } from "@/integrations/quo/config";
import { isCredentialCryptoConfigured } from "@/lib/crypto/secretBox";
import { addQuoSigningSecret, removeQuoSigningSecret, countActiveQuoSigningSecrets, getActiveQuoSigningSecrets } from "@/integrations/quo/signingSecrets";

/**
 * Owner-only управление QUO webhook signing secrets. Полное значение НИКОГДА не возвращается в
 * браузер и не логируется. Аудит фиксирует только действие added/removed + маску (без значения).
 */

type Result = { ok?: true; error?: string };

/** Аудит действия БЕЗ значения секрета (только маска). */
function auditSecretAction(event: "added" | "removed", userId: string, maskedSuffix: string) {
  console.info(JSON.stringify({ scope: "integration-secret", provider: "QUO", kind: "webhook_signing_secret", event, userId, maskedSuffix }));
}

export async function ownerAddQuoSigningSecret(secret: string): Promise<Result> {
  const user = await requireRole("OWNER");
  const r = await addQuoSigningSecret(prisma, secret);
  if (!r.ok) return { error: r.error };
  auditSecretAction("added", user.id, r.maskedSuffix);
  revalidatePath("/dashboard/sites");
  return { ok: true };
}

export async function ownerRemoveQuoSigningSecret(id: string): Promise<Result> {
  const user = await requireRole("OWNER");
  const r = await removeQuoSigningSecret(prisma, id);
  if (!r.ok) return { error: "Secret не найден." };
  auditSecretAction("removed", user.id, r.maskedSuffix ?? "");
  revalidatePath("/dashboard/sites");
  return { ok: true };
}

export type QuoSigningConfig = { cryptoConfigured: boolean; envCount: number; dbCount: number; totalActive: number; decryptOk: boolean };

/** «Проверить конфигурацию»: подтверждает сохранение/расшифровку и число ключей. Без значений. */
export async function ownerCheckQuoSigningConfig(): Promise<QuoSigningConfig> {
  await requireRole("OWNER");
  const envCount = getQuoSigningKeys().length;
  const dbCount = await countActiveQuoSigningSecrets(prisma);
  const decrypted = await getActiveQuoSigningSecrets(prisma);
  return { cryptoConfigured: isCredentialCryptoConfigured(), envCount, dbCount, totalActive: envCount + dbCount, decryptOk: decrypted.length === dbCount };
}
