import "server-only";
/**
 * Возврат денег клиенту через Airwallex.
 *
 * ЭТО НЕОБРАТИМАЯ ОПЕРАЦИЯ, и здесь единственное место, где она запускается. Всё остальное —
 * проверки, ради которых это место и вынесено отдельно от UI.
 *
 * Своей таблицы возвратов НЕТ намеренно. Сколько уже возвращено, спрашиваем у Airwallex: там
 * лежит правда, включая возвраты, сделанные мимо нас — из кабинета Airwallex или из
 * WooCommerce. Собственная копия молча разошлась бы с ней, и «доступно к возврату» стало бы
 * враньём в самом опасном месте.
 */
import { prisma } from "@/lib/db";
import { AirwallexClient, type AirwallexRefund } from "./client";
import { resolveAirwallexCreds } from "./settings";

/** Что показать владельцу до нажатия кнопки. */
export type RefundState =
  | { available: false; reason: string }
  | {
      available: true;
      currency: string;
      /** Сколько всего оплачено, в единицах валюты. */
      paidAmount: number;
      /** Сколько уже возвращено (успешные и ещё идущие возвраты). */
      refundedAmount: number;
      /** Сколько можно вернуть сейчас. */
      availableAmount: number;
      refunds: AirwallexRefund[];
    };

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Возвраты, которые уже «съели» деньги.
 *
 * Идущие (RECEIVED/PENDING/PROCESSING) считаются наравне с завершёнными: деньги по ним уже
 * обещаны, и если не учесть их, владелец вернёт сумму второй раз, пока первая в пути.
 * Не считаются только те, что точно не состоятся.
 */
const DEAD_REFUND_STATUSES = ["FAILED", "CANCELLED", "EXPIRED", "DECLINED"];
const countsAsRefunded = (r: AirwallexRefund) => !DEAD_REFUND_STATUSES.includes(r.status.toUpperCase());

/**
 * Сколько уже возвращено и сколько можно вернуть. Чистая функция — здесь считаются деньги,
 * и проверяться это должно тестом, а не наблюдением за живыми возвратами.
 */
export function computeRefundAmounts(
  paidAmount: number,
  refunds: AirwallexRefund[]
): { refundedAmount: number; availableAmount: number } {
  const refundedAmount = round2(refunds.filter(countsAsRefunded).reduce((a, r) => a + r.amount, 0));
  // Отрицательного остатка не бывает: если возвращено больше списанного (так бывает при
  // ручных операциях в кабинете), доступно ноль, а не минус.
  return { refundedAmount, availableAmount: round2(Math.max(paidAmount - refundedAmount, 0)) };
}

async function loadPayment(orderId: string) {
  return prisma.airwallexPayment.findUnique({
    where: { orderId },
    select: { siteId: true, paymentIntentId: true },
  });
}

/**
 * Состояние возврата по заказу. Только чтение: ходит в Airwallex за платежом и его
 * возвратами, ничего не меняет.
 */
export async function getRefundState(orderId: string): Promise<RefundState> {
  const pay = await loadPayment(orderId);
  if (!pay?.paymentIntentId) return { available: false, reason: "Заказ не оплачен через Airwallex." };

  const creds = await resolveAirwallexCreds(prisma, pay.siteId);
  if (!creds) return { available: false, reason: "У магазина не заданы ключи Airwallex." };

  const client = new AirwallexClient(creds);
  const intent = await client.getPaymentIntent(pay.paymentIntentId);
  if (!intent.ok) return { available: false, reason: `Airwallex не ответил (${intent.code}).` };
  if (!intent.found) return { available: false, reason: "Платёж не найден в Airwallex." };
  if (intent.status !== "SUCCEEDED") {
    return { available: false, reason: `Возврат возможен только по успешному платежу, сейчас статус «${intent.rawStatus}».` };
  }

  // Возвращать можно только то, что реально списано.
  const paidAmount = intent.capturedAmount ?? intent.amount ?? 0;
  if (paidAmount <= 0) return { available: false, reason: "По платежу нет списанной суммы." };

  const list = await client.listRefunds(pay.paymentIntentId);
  if (!list.ok) return { available: false, reason: `Не удалось получить список возвратов (${list.code}).` };

  const { refundedAmount, availableAmount } = computeRefundAmounts(round2(paidAmount), list.refunds);
  return {
    available: true,
    currency: intent.currency ?? "USD",
    paidAmount: round2(paidAmount),
    refundedAmount,
    availableAmount,
    refunds: list.refunds,
  };
}

/** Короткая сводка возвратов для панели заказа. */
export type RefundSummary = {
  /** Сколько возвращено (идущие возвраты считаются — см. computeRefundAmounts). */
  amount: number;
  currency: string;
  /** Когда прошёл последний возврат. */
  lastAt: string | null;
  /** Статус последнего возврата, как его называет Airwallex. */
  lastStatus: string;
  count: number;
};

/**
 * Возвраты по заказу для ПОКАЗА в панели Airwallex. Best-effort: ошибка и отсутствие ключей
 * дают null, и панель просто рисуется как раньше — платёж важнее, чем сводка по нему.
 *
 * Один запрос, а не два: статус платежа панель уже знает из своей таблицы, а
 * `payment_intent` после возврата всё равно остаётся SUCCEEDED — возврат у Airwallex это
 * отдельный объект, и без этого списка о нём никак не узнать.
 */
export async function getRefundSummary(orderId: string): Promise<RefundSummary | null> {
  const pay = await loadPayment(orderId);
  if (!pay?.paymentIntentId) return null;

  const creds = await resolveAirwallexCreds(prisma, pay.siteId);
  if (!creds) return null;

  const list = await new AirwallexClient(creds).listRefunds(pay.paymentIntentId);
  if (!list.ok || list.refunds.length === 0) return null;

  const { refundedAmount } = computeRefundAmounts(0, list.refunds);
  if (refundedAmount <= 0) return null;

  // Последний по времени: Airwallex отдаёт список без гарантии порядка.
  const sorted = [...list.refunds].sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
  return {
    amount: refundedAmount,
    currency: sorted[0].currency || "USD",
    lastAt: sorted[0].createdAt,
    lastStatus: sorted[0].status,
    count: list.refunds.length,
  };
}

export type CreateRefundOutcome =
  | { ok: true; refund: AirwallexRefund }
  /** Возврат точно НЕ создан — можно спокойно повторить. */
  | { ok: false; kind: "rejected"; message: string }
  /** Ответ не дошёл: возврат мог пройти. Повторять нельзя, нужно смотреть список. */
  | { ok: false; kind: "unknown"; message: string };

/**
 * Создать возврат. Вызывается только из действия владельца после подтверждения.
 *
 * `requestId` приходит СНАРУЖИ и не генерируется здесь: он должен быть один и тот же у всех
 * попыток одной и той же формы, иначе идемпотентность Airwallex не спасёт от двойного
 * возврата при повторной отправке.
 *
 * Сумма проверяется заново, по свежим данным Airwallex, а не по тому, что показала форма:
 * между открытием модалки и нажатием кнопки возврат мог сделать кто-то ещё.
 */
export async function createOrderRefund(input: {
  orderId: string;
  amount: number;
  reason: string;
  requestId: string;
}): Promise<CreateRefundOutcome> {
  const pay = await loadPayment(input.orderId);
  if (!pay?.paymentIntentId) return { ok: false, kind: "rejected", message: "Заказ не оплачен через Airwallex." };

  const state = await getRefundState(input.orderId);
  if (!state.available) return { ok: false, kind: "rejected", message: state.reason };

  const amount = round2(input.amount);
  if (!(amount > 0)) return { ok: false, kind: "rejected", message: "Сумма возврата должна быть больше нуля." };
  if (amount > state.availableAmount) {
    return {
      ok: false,
      kind: "rejected",
      message: `Доступно к возврату ${state.availableAmount} ${state.currency}, запрошено ${amount}.`,
    };
  }

  const creds = await resolveAirwallexCreds(prisma, pay.siteId);
  if (!creds) return { ok: false, kind: "rejected", message: "У магазина не заданы ключи Airwallex." };

  const res = await new AirwallexClient(creds).createRefund({
    paymentIntentId: pay.paymentIntentId,
    amount,
    currency: state.currency,
    reason: input.reason,
    requestId: input.requestId,
  });

  if (res.ok) return { ok: true, refund: res.refund };

  // Сеть/пустой ответ — исход неизвестен. Не говорим «не получилось»: деньги могли уйти.
  if (res.code === "network_unknown" || res.code === "empty_response") {
    return {
      ok: false,
      kind: "unknown",
      message: "Airwallex не ответил. Возврат мог пройти — проверьте список возвратов и не повторяйте вслепую.",
    };
  }
  return { ok: false, kind: "rejected", message: res.message ?? `Airwallex отклонил возврат (${res.code}).` };
}
