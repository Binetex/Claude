"use server";
/**
 * Тексты сообщений клиенту и сроки воронки — действия владельца. ТОЛЬКО OWNER: это то, что
 * увидит покупатель, и решать за магазин колл-центру не по чину.
 */
import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/rbac";
import { saveReviewSettings, type ReviewSettingsInput } from "@/modules/reviews/settings";
import { prisma } from "@/lib/db";
import { saveReviewReward } from "@/modules/reviews/reward";

export type SettingsFormResult = { ok?: true; warning?: string; error?: string };

export async function saveReviewSettingsAction(
  siteId: string,
  input: ReviewSettingsInput
): Promise<SettingsFormResult> {
  await requireRole("OWNER");
  const res = await saveReviewSettings(siteId, input);
  if (!res.ok) return { error: res.error };
  revalidatePath("/dashboard/reviews/messages");
  return { ok: true, warning: res.warning };
}

/** Купон за отзыв — один на все магазины, поэтому и настройка одна, не по магазинам. */
export async function saveCouponAction(input: { couponCode: string; couponSms: string }): Promise<SettingsFormResult> {
  await requireRole("OWNER");
  // Кириллица в тексте клиенту — та же ошибка, что и в остальных сообщениях наружу.
  if (/[\u0400-\u04FF]/.test(input.couponSms)) {
    return { error: "Текст клиенту пишется по-английски: покупатели англоязычные." };
  }
  await saveReviewReward(prisma, input);
  revalidatePath("/dashboard/reviews/messages");
  revalidatePath("/dashboard/reviews/requests");
  revalidatePath("/dashboard/cc/reviews");
  return { ok: true };
}
