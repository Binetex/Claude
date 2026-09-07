import "server-only";
/**
 * Запись УЖЕ СДЕЛАННОГО возврата в WooCommerce.
 *
 * ЗАЧЕМ. Кнопка «Вернуть деньги» возвращает их через Airwallex, и магазин об этом не узнаёт
 * никогда: заказ в Woo остаётся оплаченным, в отчётах денег нет, а клиенту не уходит письмо
 * о возврате — то самое, которое WooCommerce шлёт сам, когда возврат оформлен в нём. Здесь мы
 * закрываем этот разрыв: сообщаем магазину о возврате, и дальше он делает всё сам, своими
 * шаблонами и своей почтой.
 *
 * ДЕНЕГ ЭТОТ КОД НЕ ДВИГАЕТ. `api_refund: false` означает «возврат уже сделан вне магазина,
 * просто запиши» — ровно то же, что кнопка «Refund manually» в админке Woo. Значение `true`
 * заставило бы плагин Airwallex вернуть деньги ВТОРОЙ раз, поэтому оно здесь не появляется ни
 * при каких условиях и не выносится в параметр.
 *
 * Своей таблицы возвратов у нас по-прежнему нет: что уже записано в магазине, спрашиваем у
 * самого магазина (`findRecordedRefund`) по метке с id возврата Airwallex.
 */
import { wooRequest } from "./client";
import type { WooCredentials } from "./credentials";

/** Метка на возврате в Woo: по ней узнаём СВОЮ запись и не делаем вторую. */
export const WOO_REFUND_MARKER_KEY = "_floremart_airwallex_refund_id";

type WooRefundRow = {
  id: number;
  amount?: string;
  meta_data?: { key?: string; value?: unknown }[];
};

/** Уже записанный нами возврат Airwallex, если он есть. Ищем по метке, а не по сумме: */
/** двух одинаковых сумм по одному заказу достаточно, чтобы перепутать (частичные возвраты). */
export async function findRecordedRefund(
  creds: WooCredentials,
  externalOrderId: string,
  airwallexRefundId: string
): Promise<number | null> {
  const res = await wooRequest<WooRefundRow[]>(creds, `/orders/${encodeURIComponent(externalOrderId)}/refunds`, {
    query: { per_page: 100 },
  });
  const hit = (res.data ?? []).find((r) =>
    (r.meta_data ?? []).some((m) => m.key === WOO_REFUND_MARKER_KEY && String(m.value) === airwallexRefundId)
  );
  return hit ? hit.id : null;
}

/**
 * Записывает возврат в магазин. Возвращает id записи Woo.
 *
 * Сумма — строкой в валюте заказа, как ждёт Woo. Причина уходит та же, что владелец указал в
 * форме возврата и что ушла в Airwallex: расходиться этим двум записям незачем.
 */
export async function recordWooRefund(
  creds: WooCredentials,
  externalOrderId: string,
  input: { amount: number; reason: string; airwallexRefundId: string }
): Promise<number> {
  const res = await wooRequest<WooRefundRow>(creds, `/orders/${encodeURIComponent(externalOrderId)}/refunds`, {
    method: "POST",
    body: {
      amount: input.amount.toFixed(2),
      reason: input.reason,
      // Деньги уже вернул Airwallex. См. заголовок файла: true здесь означало бы второй возврат.
      api_refund: false,
      // Товары обратно на склад не возвращаем: остатков мы в Woo не ведём.
      api_restock: false,
      meta_data: [{ key: WOO_REFUND_MARKER_KEY, value: input.airwallexRefundId }],
    },
  });
  return res.data?.id ?? 0;
}
