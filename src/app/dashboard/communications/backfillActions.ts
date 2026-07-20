"use server";
import { requireUser } from "@/lib/rbac";
import { prisma } from "@/lib/db";
import { featureFlags } from "@/lib/featureFlags";
import { getQuoConfig } from "@/integrations/quo/config";
import { createQuoClient } from "@/integrations/quo/client";
import { runBackfill, BackfillConcurrentError, type BackfillReport } from "@/integrations/quo/backfill";
import { reprocessUnlinkedCommunications } from "@/integrations/quo/communicationsService";

type FormState = { ok?: boolean; error?: string; report?: BackfillReport; relinked?: number } | null;

/**
 * Запуск backfill из админки. Доступно ЛЮБОМУ аутентифицированному сотруднику (requireUser).
 * DRY-RUN по умолчанию; LIVE требует явного confirm=1 (перед этим всегда доступен dry-run).
 * Реальные вызовы QUO — только при настроенном ключе И QUO_ENABLED.
 */
export async function startBackfillAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser();
  const mode = formData.get("mode") === "LIVE" ? "LIVE" : "DRY_RUN";
  const confirm = formData.get("confirm") === "1";
  if (mode === "LIVE" && !confirm) return { error: "Реальный импорт требует подтверждения. Сначала выполните dry-run." };

  const cfg = getQuoConfig();
  if (!cfg || !featureFlags.quo) return { error: "QUO не настроен (нужны QUO_API_KEY и QUO_ENABLED)." };

  const days = Number(String(formData.get("days") ?? "30")) || 30;
  const toRaw = String(formData.get("to") ?? "");
  const fromRaw = String(formData.get("from") ?? "");
  const to = toRaw ? new Date(toRaw) : new Date();
  const from = fromRaw ? new Date(fromRaw) : new Date(to.getTime() - days * 24 * 3600 * 1000);
  const siteId = String(formData.get("siteId") ?? "") || undefined;
  const quoPhoneNumberId = String(formData.get("quoPhoneNumberId") ?? "") || undefined;

  const client = createQuoClient(cfg);
  try {
    const report = await runBackfill(prisma, client, { mode, from, to, siteId, quoPhoneNumberId, initiatedByUserId: user.id });
    return { ok: true, report };
  } catch (err) {
    if (err instanceof BackfillConcurrentError) return { error: "Уже выполняется LIVE-импорт. Дождитесь завершения." };
    return { error: "Ошибка импорта QUO." };
  }
}

/** Повторно обработать непривязанные события (привязать при появлении подходящего заказа). */
export async function reprocessUnlinkedAction(): Promise<FormState> {
  await requireUser();
  const res = await reprocessUnlinkedCommunications(prisma, {});
  return { ok: true, relinked: res.linked };
}
