"use server";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/rbac";
import { prisma } from "@/lib/db";
import { featureFlags } from "@/lib/featureFlags";
import { getQuoConfig } from "@/integrations/quo/config";
import { createQuoClient } from "@/integrations/quo/client";
import { sendOrderSms, type SendTarget } from "@/integrations/quo/send";
import { describeSendFailure } from "@/lib/smsFailure";

type FormState = { ok?: boolean; error?: string; status?: string } | null;

/**
 * Отправка SMS из карточки заказа. Доступна ЛЮБОМУ аутентифицированному сотруднику
 * (requireUser, НЕ OWNER-only). Клиент создаётся БЕЗ авто-ретрая (maxRetries:0). Отправка идёт
 * только при настроенном номере QUO у магазина и включённом QUO_ENABLED.
 */
export async function sendOrderSmsAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser();
  const orderId = String(formData.get("orderId") ?? "");
  const target = String(formData.get("target") ?? "") as SendTarget;
  const text = String(formData.get("text") ?? "");
  const idempotencyKey = String(formData.get("idempotencyKey") ?? "");
  if (!orderId || (target !== "CUSTOMER" && target !== "RECIPIENT")) return { error: "Некорректный запрос." };

  const cfg = getQuoConfig();
  const client = cfg && featureFlags.quo ? createQuoClient({ ...cfg, maxRetries: 0 }) : null;

  const res = await sendOrderSms(prisma, client, { orderId, target, text, idempotencyKey, sentByUserId: user.id });
  revalidatePath(`/dashboard/orders/${orderId}`);
  if (res.ok) return { ok: true, status: res.status };
  // Подписи общие с Telegram-ботом (`lib/smsFailure`): один и тот же отказ обязан читаться
  // одинаково, где бы человек его ни увидел.
  return { error: describeSendFailure(res.code, res.detail) };
}
