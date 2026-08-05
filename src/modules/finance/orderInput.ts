import "server-only";
/**
 * Отображение «строка заказа → вход расчёта дня» (`DayOrderInput`).
 *
 * Вынесено из dayFinance, потому что этим занимаются двое: расчёт дня конкретного флориста
 * и дашборд владельца, который считает то же самое по ВСЕМ заказам сразу. Копия этой логики
 * означала бы две формулы прибыли, расходящиеся при первой же правке.
 *
 * Настройки магазинов принимаются УЖЕ ЗАГРУЖЕННЫМИ. Раньше ставка расходников и модель
 * эквайринга резолвились внутри цикла по заказам — по два запроса на заказ при шести
 * магазинах во всей системе. Теперь они грузятся один раз на всю выборку, и число запросов
 * перестало зависеть от числа заказов.
 */
import { toNumber } from "@/lib/money";
import type { DayOrderInput } from "./dayCalc";
import { estimateFeeCents, type ResolvedConsumables, type ResolvedFeeModel } from "./settings";
import type { ItemFinance } from "./itemFinance";

const toCents = (v: unknown) => Math.round(toNumber(v as never) * 100);

/** Ровно те поля заказа, которые нужны расчёту. */
export type OrderRowForFinance = {
  id: string;
  orderNumber: string;
  siteId: string;
  itemsTotal: unknown;
  tax: unknown;
  tip: unknown;
  deliveryCustomerCost: unknown;
  deliveryActualCost: unknown;
  deliveryActualCostConfirmedAt: Date | null;
  customerTotal: unknown;
  acquiringFee: { feeCents: number } | null;
  consumablesOverride: { amountCents: number } | null;
  items: { id: string; quantity: number }[];
};

export type FinanceSettingsBySite = {
  /** Ставка расходников магазина; отсутствие ключа = ставки нет. */
  consumables: Map<string, ResolvedConsumables | null>;
  feeModels: Map<string, ResolvedFeeModel | null>;
};

/**
 * Закупка ваз и подарков по заказу.
 *
 * Если хоть у одной позиции она неизвестна — неизвестна ВСЯ сумма, а не «сколько нашли»:
 * частичная сумма занизила бы расход и завысила прибыль.
 */
function vaseGiftCostFor(
  items: { id: string; quantity: number }[],
  itemFinance: Map<string, ItemFinance>
): number | null {
  let total = 0;
  for (const item of items) {
    const fin = itemFinance.get(item.id);
    if (!fin || fin.isTip) continue;
    if (fin.costRequired && fin.purchaseCostCents == null) return null;
    if (fin.purchaseCostCents != null) total += fin.purchaseCostCents * item.quantity;
  }
  return total;
}

/**
 * Строит входы расчёта. Чистая функция: ни запросов, ни «сейчас».
 *
 * NULL в расходе означает «неизвестно» и останавливает день. Ноль — подтверждённое
 * «не платим»; путать их нельзя, иначе прибыль окажется завышенной.
 */
export function toDayOrderInputs(
  orders: OrderRowForFinance[],
  deps: {
    additionalByOrder: Map<string, number>;
    itemFinance: Map<string, ItemFinance>;
    settings: FinanceSettingsBySite;
  }
): DayOrderInput[] {
  return orders.map((order) => {
    // Подтверждённый ноль — валидная стоимость, неподтверждённый — неизвестность.
    const deliveryCents = toCents(order.deliveryActualCost);
    const deliveryActualCents =
      order.deliveryActualCostConfirmedAt != null || deliveryCents > 0 ? deliveryCents : null;

    // Фактическая комиссия приоритетнее модели магазина.
    const feeModel = order.acquiringFee ? null : (deps.settings.feeModels.get(order.siteId) ?? null);
    const acquiringFeeCents = order.acquiringFee
      ? order.acquiringFee.feeCents
      : feeModel
        ? estimateFeeCents(feeModel, toCents(order.customerTotal))
        : null;

    const rate = order.consumablesOverride ? null : (deps.settings.consumables.get(order.siteId) ?? null);
    const consumablesCents = order.consumablesOverride ? order.consumablesOverride.amountCents : (rate?.amountCents ?? null);

    return {
      orderId: order.id,
      orderNumber: order.orderNumber,
      siteId: order.siteId,
      grossRevenueCents:
        toCents(order.itemsTotal) + toCents(order.tax) + toCents(order.deliveryCustomerCost) + toCents(order.tip),
      customerTotalCents: toCents(order.customerTotal),
      tipCents: toCents(order.tip),
      taxCents: toCents(order.tax),
      deliveryActualCents,
      acquiringFeeCents,
      vaseGiftCostCents: vaseGiftCostFor(order.items, deps.itemFinance),
      consumablesCents,
      additionalCents: deps.additionalByOrder.get(order.id) ?? 0,
      feeFromActual: order.acquiringFee != null,
      consumablesFromOverride: order.consumablesOverride != null,
    };
  });
}
