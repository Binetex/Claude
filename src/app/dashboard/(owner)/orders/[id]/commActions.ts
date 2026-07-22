"use server";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/rbac";
import { prisma } from "@/lib/db";
import { featureFlags } from "@/lib/featureFlags";
import { getQuoConfig } from "@/integrations/quo/config";
import { createQuoClient } from "@/integrations/quo/client";
import { sendOrderSms, type SendTarget } from "@/integrations/quo/send";

type FormState = { ok?: boolean; error?: string; status?: string } | null;

const ERR_RU: Record<string, string> = {
  empty_text: "Введите текст сообщения.",
  too_long: "Слишком длинное сообщение (макс. 1600 символов).",
  invalid_target_phone: "У этого адресата некорректный номер телефона.",
  store_no_quo_number: "У магазина не настроен номер QUO для отправки SMS.",
  store_quo_disabled: "QUO отключён для этого магазина — включите его в настройках сайта.",
  quo_not_configured: "Интеграция QUO не настроена.",
  order_not_found: "Заказ не найден.",
  missing_idempotency_key: "Повторите отправку.",
  quo_auth: "QUO отклонил запрос (авторизация).",
  quo_forbidden: "QUO: недостаточно прав.",
  quo_not_found: "QUO: ресурс не найден.",
  quo_rate_limit: "QUO: превышен лимит запросов, попробуйте позже.",
  quo_server: "QUO временно недоступен, попробуйте позже.",
  quo_network: "Сетевая ошибка при обращении к QUO.",
  quo_client: "QUO отклонил запрос.",
};

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
  return { error: ERR_RU[res.code] ?? "Не удалось отправить SMS." };
}
