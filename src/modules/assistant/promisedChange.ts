import "server-only";
/**
 * Перенос дня и окна заказа по переписке с клиентом — в момент, когда ответ ассистента УШЁЛ
 * (сам или по кнопке человека), и только на то, что клиент назвал сам (владелец 30.09.2026).
 *
 * Раньше заказ двигался сразу при разборе, даже когда ответ ждал человека черновиком: FLWBR-91180
 * переехал на другой день, а ответ «привезём завтра с 10 до 12» так и не ушёл (его придержали:
 * к 10 не успевали), и клиенту назавтра снова пришло «когда вам удобно?» со старым окном. А на
 * «the earliest you can» модель пообещала «from 3:30», и THEFLOW-20876 получил окно 3:30–9 PM —
 * флорист прочёл это как «клиенту можно поздно».
 *
 * Теперь: пока ответ не ушёл, заказ стоит; человек написал свой ответ или отклонил черновик — заказ
 * не двигается, решает он. Ушёл ответ ассистента — обещание сверяется со словами клиента
 * (`clientTime.ts`) и только тогда становится днём и окном заказа.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { windowOf, windowFields, formatWindowText, type WindowRange } from "@/lib/deliveryWindow";
import { dayDiff, localClock, storeDateTimeFormat } from "@/lib/tz";
import { recomputeDaysForOrder } from "@/modules/finance/orderDayHook";
import { scheduleDeliveryTodayTrigger } from "@/modules/automations/lifecycle";
import { onOrderDeliveryChangeSafe } from "@/integrations/delivery/burq/scheduleService";
import { notifyDeliveryChanged } from "@/integrations/notifications/telegram";
import { publishWooDeliveryPush } from "@/integrations/woocommerce/deliveryPushEvents";
import { emailNewText } from "@/integrations/emailFactory/ingest";
import { planReschedule } from "./reschedule";
import { promisedChangeOf } from "./prompt";
import { clientConfirmed } from "./clientTime";
import { BURST_MAX, BURST_WINDOW_MIN, takeDeferredQueue } from "./burst";

function dayLabel(day: string, window: string): string {
  return `${day.slice(8, 10)}.${day.slice(5, 7)} ${window || ""}`.trim();
}

/**
 * Перенос по словам клиента — то же, что перенос в карточке: флористу сообщение, Burq
 * перепланирует, «доставка сегодня» — на новый день, финансы пересчитываются за ОБА дня, заказ
 * Woo получает новые дату и слот. В заметке строка, кто и что поменял: журнала правок от имени
 * ассистента нет. Если курьер уже вызван — не трогаем: перепланирование отменило бы курьера.
 */
export async function applyCustomerReschedule(
  prisma: PrismaClient,
  orderId: string,
  confirmed: { from: number | null; until: number | null },
  newDate: string | null,
  tz: string | null,
  todayStr: string
): Promise<void> {
  const o = await prisma.order.findUnique({
    where: { id: orderId },
    select: { deliveryWindow: true, windowFrom: true, windowTo: true, deliveryDate: true, orderStatus: true, platform: true, customerNote: true },
  });
  if (!o || o.orderStatus === "DELIVERED" || o.orderStatus === "CANCELLED") return;
  if (o.orderStatus === "AWAITING_COURIER" || o.orderStatus === "IN_TRANSIT") return;
  const dispatched = await prisma.delivery.count({
    where: { orderId, isCurrentAttempt: true, status: { notIn: ["DRAFT_PENDING", "DRAFT_CREATED", "CANCELLED", "FAILED"] } },
  });
  if (dispatched) return;

  const currentDay = o.deliveryDate.toISOString().slice(0, 10);
  if (dayDiff(todayStr, currentDay) < 0) return;
  const current = windowOf(o);
  const plan = planReschedule({ todayStr, currentDay, currentWindow: current, confirmed, newDate });
  const sameWindow = plan?.window && current ? plan.window.from === current.from && plan.window.to === current.to : !plan?.window;
  if (!plan || (plan.day === currentDay && sameWindow)) return;

  const text = (w: WindowRange | null) => (w ? formatWindowText(w) : o.deliveryWindow);
  const from = dayLabel(currentDay, text(current));
  const to = dayLabel(plan.day, text(plan.window));
  const stamp = storeDateTimeFormat(tz, { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date());
  const line = `${stamp} · ИИ перенёс доставку по просьбе клиента: ${from} → ${to}`;
  const dateChanged = plan.day !== currentDay;
  await prisma.order.update({
    where: { id: orderId },
    data: {
      // Окно строго «с — до»; текст окна — одним форматом из него же.
      ...(plan.window && !sameWindow ? windowFields(plan.window) : {}),
      ...(dateChanged ? { deliveryDate: new Date(`${plan.day}T00:00:00Z`) } : {}),
      customerNote: o.customerNote.trim() ? `${line}\n${o.customerNote}` : line,
    },
  });
  if (dateChanged) {
    // Заказ переехал между днями: пересчитать надо оба (как при переносе в карточке).
    await recomputeDaysForOrder(prisma, orderId, [o.deliveryDate, new Date(`${plan.day}T00:00:00Z`)]);
    await scheduleDeliveryTodayTrigger(prisma, orderId);
  }
  await onOrderDeliveryChangeSafe(prisma, orderId);
  await notifyDeliveryChanged(orderId, { fromText: from, toText: to, by: "ИИ по переписке с клиентом" });
  if (o.platform === "WOOCOMMERCE") await publishWooDeliveryPush(prisma, orderId);
}

/**
 * Ответ ассистента ушёл клиенту — ставим в заказ то, что он пообещал, если клиент сам назвал этот
 * день и это время. `isParty` — пишет сторона заказа (заказчик или получатель по номеру, заказчик
 * по адресу письма): чужой человек, знающий имя получателя, оплаченный заказ не двигает.
 */
export async function applyPromisedChange(prisma: PrismaClient, args: { turnId: string; isParty: boolean }, now: Date = new Date()): Promise<void> {
  if (!args.isParty) return;
  const turn = await prisma.aiTurn.findUnique({
    where: { id: args.turnId },
    select: {
      orderId: true,
      responseText: true,
      site: { select: { timezone: true, aiDryRun: true } },
      communication: { select: { id: true, occurredAt: true, storePhone: true, externalPhoneNormalized: true, messageText: true, transcript: true, summary: true } },
      emailMessage: { select: { id: true, fromEmail: true, occurredAt: true, text: true } },
    },
  });
  if (!turn?.orderId || turn.site.aiDryRun) return;
  const promised = promisedChangeOf(turn.responseText);
  if (!promised || promised.intent === "spam") return;
  if (!promised.newDate && promised.from == null && promised.until == null) return;

  const message = turn.communication ?? turn.emailMessage;
  if (!message) return;
  const text = turn.communication
    ? await smsText(prisma, turn.orderId, turn.communication)
    : await emailText(prisma, turn.orderId, turn.emailMessage!);

  const tz = turn.site.timezone;
  const change = clientConfirmed({
    text,
    // «Завтра» и «в четверг» — от дня, когда клиент это написал, а не когда человек нажал «Отправить».
    messageDay: localClock(tz, message.occurredAt).dateStr,
    newDate: promised.newDate,
    from: promised.from,
    until: promised.until,
  });
  if (!change.newDate && change.from == null && change.until == null) return;
  await applyCustomerReschedule(prisma, turn.orderId, { from: change.from, until: change.until }, change.newDate, tz, localClock(tz, now).dateStr);
}

/**
 * Слова клиента, на которые ответил разбор SMS: само сообщение и отложенные в его пользу — та же
 * очередь, что видела модель (`handler.ts::loadDeferred`).
 */
async function smsText(
  prisma: PrismaClient,
  orderId: string,
  c: { id: string; occurredAt: Date; externalPhoneNormalized: string; messageText: string | null; transcript: string | null; summary: string | null }
): Promise<string> {
  const rows = await prisma.aiTurn.findMany({
    where: {
      communication: {
        orderId,
        externalPhoneNormalized: c.externalPhoneNormalized,
        occurredAt: { gte: new Date(c.occurredAt.getTime() - BURST_WINDOW_MIN * 60_000), lt: c.occurredAt },
      },
    },
    orderBy: { communication: { occurredAt: "desc" } },
    take: BURST_MAX,
    select: { status: true, skipReason: true, communication: { select: { messageText: true, transcript: true, summary: true } } },
  });
  const bodyOf = (m: { messageText: string | null; transcript: string | null; summary: string | null }) => (m.messageText || m.transcript || m.summary || "").trim();
  return [...takeDeferredQueue(rows).flatMap((r) => (r.communication ? [bodyOf(r.communication)] : [])), bodyOf(c)].filter(Boolean).join("\n");
}

/** То же для письма: письмо и дописанные вдогонку (`emailHandler.ts::loadDeferredEmails`). */
async function emailText(prisma: PrismaClient, orderId: string, e: { id: string; fromEmail: string; occurredAt: Date; text: string | null }): Promise<string> {
  const rows = await prisma.aiTurn.findMany({
    where: {
      emailMessage: {
        orderId,
        fromEmail: { equals: e.fromEmail, mode: "insensitive" },
        occurredAt: { gte: new Date(e.occurredAt.getTime() - BURST_WINDOW_MIN * 60_000), lt: e.occurredAt },
      },
    },
    orderBy: { emailMessage: { occurredAt: "desc" } },
    take: BURST_MAX,
    select: { status: true, skipReason: true, emailMessage: { select: { text: true } } },
  });
  return [...takeDeferredQueue(rows).flatMap((r) => (r.emailMessage ? [r.emailMessage.text] : [])), e.text]
    .map((t) => emailNewText(t ?? ""))
    .filter(Boolean)
    .join("\n");
}
