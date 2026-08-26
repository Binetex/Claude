"use server";
/**
 * Тексты сообщений клиенту и сроки воронки — действия владельца. ТОЛЬКО OWNER: это то, что
 * увидит покупатель, и решать за магазин колл-центру не по чину.
 */
import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/rbac";
import { saveReviewSettings, type ReviewSettingsInput } from "@/modules/reviews/settings";

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
