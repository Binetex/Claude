/**
 * Расчёт финансового итога дня. Чистые функции: ни Prisma, ни «сейчас».
 *
 * Модель плоская и совпадает с тем, как владелец считал это в таблице:
 *
 *   выручка − чаевые − налог − доставка − комиссия − вазы − расходники − доп.расходы
 *           − дневная закупка цветов
 *   = распределяемая прибыль × доля
 *
 * Ключевое отличие от прежней версии: **дневная закупка вычитается один раз на уровне
 * дня**, а не раскладывается по заказам и не собирается обратно. Раскладка была нужна
 * только потому, что расчёт хранился в позаказных строках, — вместе с ней уходят
 * знаменатель распределения, «нераспределённый остаток» и зависимость расчёта от
 * классификации каталога.
 *
 * День считается ЦЕЛИКОМ или не считается вовсе: незаполненный заказ останавливает день.
 * Так число появляется один раз и не меняется задним числом.
 */

/** Чего не хватает по заказу. Совпадает с кодами прежнего расчёта — их знает очередь. */
export type MissingInput =
  | "DELIVERY_ACTUAL_COST"
  | "ACQUIRING_FEE"
  | "VASE_GIFT_COST"
  | "CONSUMABLES_RATE";

export type DayOrderInput = {
  orderId: string;
  orderNumber: string;
  siteId: string;
  /** Всё, что заплатил клиент: товары + налог + доставка + чаевые. */
  grossRevenueCents: number;
  tipCents: number;
  taxCents: number;
  /** null — фактическая доставка не подтверждена, а не «бесплатно». */
  deliveryActualCents: number | null;
  acquiringFeeCents: number | null;
  vaseGiftCostCents: number | null;
  consumablesCents: number | null;
  /** Дополнительные расходы по заказу: повторная доставка, переделка, компенсация. */
  additionalCents: number;
};

export type DayOrderResult = DayOrderInput & {
  missing: MissingInput[];
  /** Вклад заказа в прибыль дня ДО вычета дневной закупки. */
  contributionCents: number;
};

export type DayBlocker = "DAILY_FLOWER_EXPENSE_MISSING" | "ORDER_DATA_INCOMPLETE";

export type DayFinanceResult = {
  complete: boolean;
  blockers: DayBlocker[];
  ordersTotal: number;
  grossRevenueCents: number;
  tipsCents: number;
  taxCents: number;
  deliveryCents: number;
  acquiringFeeCents: number;
  vaseGiftCostCents: number;
  consumablesCents: number;
  flowerPurchaseCents: number;
  additionalCents: number;
  distributableCents: number;
  orders: DayOrderResult[];
};

/**
 * Вклад одного заказа: сколько он приносит дню до дневной закупки.
 *
 * Чаевые входят в выручку и тут же вычитаются: на итог они не влияют, но видно, что они
 * учтены и принадлежат владельцу. Налог вычитается полностью — это база флориста.
 *
 * Неизвестный расход — это не ноль. Ноль означал бы «расхода не было» и завысил бы
 * прибыль; поэтому заказ помечается неполным, а его вклад не считается.
 */
export function computeOrderContribution(o: DayOrderInput): DayOrderResult {
  const missing: MissingInput[] = [];
  if (o.deliveryActualCents == null) missing.push("DELIVERY_ACTUAL_COST");
  if (o.acquiringFeeCents == null) missing.push("ACQUIRING_FEE");
  if (o.vaseGiftCostCents == null) missing.push("VASE_GIFT_COST");
  if (o.consumablesCents == null) missing.push("CONSUMABLES_RATE");

  const contributionCents =
    missing.length > 0
      ? 0
      : o.grossRevenueCents -
        o.tipCents -
        o.taxCents -
        (o.deliveryActualCents ?? 0) -
        (o.acquiringFeeCents ?? 0) -
        (o.vaseGiftCostCents ?? 0) -
        (o.consumablesCents ?? 0) -
        o.additionalCents;

  return { ...o, missing, contributionCents };
}

/**
 * Итог дня.
 *
 * `flowerPurchaseCents = null` — закупка не внесена: считать нечего, потому что это
 * главный расход дня и подставить вместо него ноль значит завысить прибыль.
 */
export function computeDayFinance(
  orders: DayOrderInput[],
  flowerPurchaseCents: number | null
): DayFinanceResult {
  const results = orders.map(computeOrderContribution);
  const blockers: DayBlocker[] = [];

  if (flowerPurchaseCents == null) blockers.push("DAILY_FLOWER_EXPENSE_MISSING");
  if (results.some((r) => r.missing.length > 0)) blockers.push("ORDER_DATA_INCOMPLETE");

  const complete = blockers.length === 0 && orders.length > 0;
  const sum = (pick: (r: DayOrderResult) => number) => results.reduce((a, r) => a + pick(r), 0);

  return {
    complete,
    blockers,
    ordersTotal: orders.length,
    grossRevenueCents: sum((r) => r.grossRevenueCents),
    tipsCents: sum((r) => r.tipCents),
    taxCents: sum((r) => r.taxCents),
    deliveryCents: sum((r) => r.deliveryActualCents ?? 0),
    acquiringFeeCents: sum((r) => r.acquiringFeeCents ?? 0),
    vaseGiftCostCents: sum((r) => r.vaseGiftCostCents ?? 0),
    consumablesCents: sum((r) => r.consumablesCents ?? 0),
    flowerPurchaseCents: flowerPurchaseCents ?? 0,
    additionalCents: sum((r) => r.additionalCents),
    // Неполный день не имеет распределяемой прибыли: частичная сумма — это обещание
    // денег, которых начисление не создаст.
    distributableCents: complete
      ? sum((r) => r.contributionCents) - (flowerPurchaseCents ?? 0)
      : 0,
    orders: results,
  };
}

/**
 * Доля флориста от прибыли дня, не ниже нуля.
 *
 * Отсечка применяется к сумме ДНЯ, а не к отдельному заказу: убыточный заказ гасится
 * прибыльными того же дня. Иначе флорист получал бы долю с хороших заказов, не разделяя
 * плохих.
 */
export function dayShareCents(distributableCents: number, sharePercentBp: number): number {
  if (distributableCents <= 0) return 0;
  return Math.round((distributableCents * sharePercentBp) / 10000);
}
