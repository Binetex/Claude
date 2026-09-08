"use server";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/rbac";
import { prisma } from "@/lib/db";
import { linkThreadToOrder, setThreadTopic } from "@/integrations/quo/communicationsService";
import { isTopicKey } from "@/integrations/quo/otherMessages";
import { featureFlags } from "@/lib/featureFlags";
import { getQuoConfig } from "@/integrations/quo/config";
import { createQuoClient } from "@/integrations/quo/client";
import { sendUnlinkedSms } from "@/integrations/quo/send";
import { describeSendFailure } from "@/lib/smsFailure";
import { threadHref } from "./threadKey";

type FormState = { ok?: boolean; error?: string } | null;

/**
 * Привязать ВСЮ переписку к заказу. Доступно ЛЮБОМУ аутентифицированному сотруднику
 * (requireUser, НЕ OWNER-only): разбирать входящие — их работа.
 *
 * Привязывается пара (номер собеседника + QUO-номер магазина) целиком, а не одно событие:
 * иначе разговор из восьми сообщений уходил в заказ последней репликой, а остальные семь
 * оставались в разделе и просили разбора снова.
 */
export async function linkThreadAction(_prev: FormState, formData: FormData): Promise<FormState> {
  await requireUser();
  const phone = String(formData.get("phone") ?? "").trim();
  const pnRaw = String(formData.get("pn") ?? "");
  let orderId = String(formData.get("orderId") ?? "");
  const orderNumberQuery = String(formData.get("orderNumber") ?? "").trim();
  if (!phone) return { error: "Не указан номер." };

  if (!orderId && orderNumberQuery) {
    const cleaned = orderNumberQuery.replace(/[^0-9A-Za-z-]/g, "");
    const matches = await prisma.order.findMany({ where: { orderNumber: { contains: cleaned, mode: "insensitive" } }, select: { id: true }, take: 2 });
    if (matches.length === 0) return { error: "Заказ с таким номером не найден." };
    if (matches.length > 1) return { error: "Найдено несколько заказов — уточните номер." };
    orderId = matches[0].id;
  }
  if (!orderId) return { error: "Выберите заказ или введите номер." };

  const pn = pnRaw === "" ? null : pnRaw;
  const res = await linkThreadToOrder(prisma, { phoneE164: phone, providerPhoneNumberId: pn, orderId });
  if (!res.ok) return { error: "Заказ не найден." };
  if (res.linked === 0) return { error: "Привязывать нечего: события уже в заказах." };

  revalidatePath("/dashboard/communications");
  revalidatePath(threadHref(phone, pn));
  revalidatePath(`/dashboard/orders/${orderId}`);
  return { ok: true };
}


/**
 * Ручная категория для всей переписки. Пустая строка — снять ручную метку и вернуть переписку
 * под правило. Доступно любому аутентифицированному сотруднику: разбирать входящие — их работа.
 */
export async function setThreadTopicAction(_prev: FormState, formData: FormData): Promise<FormState> {
  await requireUser();
  const phone = String(formData.get("phone") ?? "").trim();
  const pnRaw = String(formData.get("pn") ?? "");
  const topicRaw = String(formData.get("topic") ?? "").trim();
  if (!phone) return { error: "Не указан номер." };
  // Пустая строка допустима — это «снять ручную метку»; всё остальное обязано быть из списка.
  const topic = topicRaw === "" ? null : isTopicKey(topicRaw) ? topicRaw : undefined;
  if (topic === undefined) return { error: "Неизвестная категория." };

  const pn = pnRaw === "" ? null : pnRaw;
  await setThreadTopic(prisma, { phoneE164: phone, providerPhoneNumberId: pn, topic });
  revalidatePath("/dashboard/communications");
  revalidatePath(threadHref(phone, pn));
  return { ok: true };
}

/**
 * Ответ клиенту, у которого нет заказа. Единственный путь отправки в проекте — sendUnlinkedSms
 * (integrations/quo/send.ts), второго заводить нельзя.
 *
 * Клиент QUO создаётся БЕЗ авто-ретрая: idempotencyKey защищает от дубля при двойном клике, а
 * повтор внутри клиента отправил бы человеку второе сообщение.
 */
export async function sendThreadSmsAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser();
  const phone = String(formData.get("phone") ?? "").trim();
  const pnRaw = String(formData.get("pn") ?? "");
  const text = String(formData.get("text") ?? "");
  const idempotencyKey = String(formData.get("idempotencyKey") ?? "");
  if (!phone) return { error: "Не указан номер." };

  const pn = pnRaw === "" ? null : pnRaw;

  // Писать можно ТОЛЬКО тому, кто сам написал, и только от имени того магазина, на номер
  // которого он написал. Ни адресат, ни магазин из браузера не берутся: иначе подменой полей
  // формы можно было бы отправить SMS на любой номер мира с A2P-номера любого магазина.
  const anchor = await prisma.orderCommunication.findFirst({
    where: { orderId: null, externalPhoneNormalized: phone, providerPhoneNumberId: pn },
    select: { id: true },
  });
  if (!anchor) return { error: "Переписка не найдена." };
  if (!pn) return { error: "У этого номера не определён магазин — ответить из дашборда нельзя." };

  const site = await prisma.site.findFirst({ where: { quoPhoneNumberId: pn }, select: { id: true } });
  if (!site) return { error: "QUO-номер не привязан ни к одному магазину — ответить нельзя." };

  const cfg = getQuoConfig();
  const client = cfg && featureFlags.quo ? createQuoClient({ ...cfg, maxRetries: 0 }) : null;

  const res = await sendUnlinkedSms(prisma, client, { siteId: site.id, toPhone: phone, text, idempotencyKey, sentByUserId: user.id });
  revalidatePath("/dashboard/communications");
  revalidatePath(threadHref(phone, pn));
  if (res.ok) return { ok: true };
  // Подписи общие с Telegram-ботом и карточкой заказа (lib/smsFailure): один и тот же отказ
  // обязан читаться одинаково, где бы человек его ни увидел.
  return { error: describeSendFailure(res.code, res.detail) };
}
