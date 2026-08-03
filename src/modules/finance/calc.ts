/**
 * Расчёт распределяемой прибыли по заказам основного флориста. Чистые функции: ни Prisma,
 * ни «сейчас» — весь вход передаётся снаружи, поэтому арифметика денег проверяется без базы.
 *
 * Два уровня. Заказ считается сам по себе, а распределение дневной закупки цветов —
 * только на уровне ДНЯ, потому что знаменатель у него общий.
 *
 * Главное правило распределения: знаменатель берётся по ВСЕМ заказам дня, включая те,
 * которые в начисление не попадут. Если поделить закупку только между исправными, их доля
 * расходов вырастет — прибыль занизится, а вместе с ней и начисление флористу. Доля
 * проблемного заказа просто остаётся нераспределённой до его исправления.
 */
import type { AcquiringFeeSource, FinancialItemType } from "@/generated/prisma/enums";

/** Чего не хватает для расчёта. Попадает в снимок и в очередь разбора. */
export type MissingInput =
  | "DELIVERY_ACTUAL_COST"
  | "ACQUIRING_FEE"
  | "VASE_GIFT_COST"
  | "CONSUMABLES_RATE"
  | "DAILY_FLOWER_EXPENSE"
  | "FLOWER_REVENUE";

export type SnapshotItem = {
  id: string;
  name: string;
  quantity: number;
  /** Цена клиента за единицу, в центах. Скидка уже учтена (проверено на боевых данных). */
  unitPriceCents: number;
  /** Эффективный тип позиции; null — определить не удалось. */
  financialType: FinancialItemType | null;
  /** Служебная строка чаевых: в выручку и в распределение не входит никогда. */
  isTip: boolean;
};

export type AcquiringFeeInput = {
  cents: number;
  source: AcquiringFeeSource;
  /** id модели магазина у ESTIMATED; у ACTUAL — null. */
  modelId: string | null;
};

export type ConsumablesInput = {
  cents: number;
  /** Откуда взялась сумма: ставка магазина/глобальная либо ручная поправка по заказу. */
  source: "RATE" | "OVERRIDE";
  rateId: string | null;
};

export type OrderCalcInput = {
  orderId: string;
  orderNumber: string;
  siteId: string;
  /** UTC-календарный день доставки, YYYY-MM-DD. */
  deliveryDay: string;

  itemsTotalCents: number;
  taxCents: number;
  /** Чаевые владельца. В расчёте не участвуют — присутствуют только для объяснимости. */
  tipCents: number;
  deliveryCustomerCents: number;
  /** Сколько клиент заплатил всего — база процента комиссии эквайринга. */
  customerPaidCents: number;

  items: SnapshotItem[];

  deliveryActualCents: number | null;
  acquiringFee: AcquiringFeeInput | null;
  vaseGiftCostCents: number | null;
  consumables: ConsumablesInput | null;
  otherExpenseCents: number;
};

/**
 * Цветочная выручка заказа — база распределения дневной закупки.
 *
 * Считается ТОЛЬКО по позициям типа FLOWER_PRODUCT: вазы, подарки, открытки, доставка,
 * налог и чаевые в неё не входят. NULL означает «определить нельзя»: у заказа есть
 * позиция без связи с каталогом, и чем она является — неизвестно. Подставлять ноль
 * нельзя: это тихо исказило бы знаменатель всего дня.
 */
export function flowerRevenueCents(items: SnapshotItem[]): number | null {
  let sum = 0;
  for (const item of items) {
    if (item.isTip) continue;
    if (item.financialType == null) return null;
    if (item.financialType === "FLOWER_PRODUCT") sum += item.unitPriceCents * item.quantity;
  }
  return sum;
}

export type AllocationShare = { orderId: string; flowerRevenueCents: number };

/**
 * Делит дневную закупку пропорционально цветочной выручке.
 *
 * Метод наибольшего остатка: сумма долей ТОЧНО равна закупке, ни цента не теряется и не
 * появляется. При равных остатках порядок задаётся orderId — результат обязан быть
 * одинаковым при каждом пересчёте, иначе ревизии снимка расходились бы на цент.
 *
 * NULL — распределить нельзя: нулевой знаменатель при ненулевой закупке. Молча раскидать
 * поровну значило бы придумать данные.
 */
export function allocateFlowerExpense(
  expenseCents: number,
  shares: AllocationShare[]
): Map<string, number> | null {
  const result = new Map<string, number>();
  if (shares.length === 0) return expenseCents === 0 ? result : null;

  const denominator = shares.reduce((a, s) => a + s.flowerRevenueCents, 0);
  if (denominator <= 0) {
    if (expenseCents === 0) {
      for (const s of shares) result.set(s.orderId, 0);
      return result;
    }
    return null;
  }

  const withRemainder = shares.map((s) => {
    const exact = expenseCents * s.flowerRevenueCents;
    const base = Math.floor(exact / denominator);
    return { orderId: s.orderId, base, remainder: exact - base * denominator };
  });

  const distributed = withRemainder.reduce((a, r) => a + r.base, 0);
  let leftover = expenseCents - distributed;

  const byRemainder = [...withRemainder].sort(
    (a, b) => b.remainder - a.remainder || (a.orderId < b.orderId ? -1 : 1)
  );
  for (const row of byRemainder) {
    if (leftover <= 0) break;
    row.base += 1;
    leftover -= 1;
  }

  for (const row of withRemainder) result.set(row.orderId, row.base);
  return result;
}

export type OrderSnapshotResult = {
  orderId: string;
  isCalculable: boolean;
  missing: MissingInput[];
  /** Сколько клиент заплатил всего, ВКЛЮЧАЯ чаевые. */
  grossRevenueCents: number;
  /** Чаевые: входят в выручку и тут же вычитаются — они деньги владельца. */
  tipsCents: number;
  flowerRevenueCents: number;
  taxCents: number;
  deliveryActualCents: number;
  acquiringFeeCents: number;
  acquiringFeeSource: AcquiringFeeSource;
  vaseGiftCostCents: number;
  consumablesCents: number;
  allocatedFlowerCents: number;
  otherExpenseCents: number;
  distributableCents: number;
};

/**
 * Считает один заказ. `allocatedFlowerCents` приходит снаружи: его знает только уровень дня.
 *
 * Выручка = ВСЁ, что заплатил клиент: товары + налог + доставка + чаевые. Чаевые и налог
 * тут же вычитаются отдельными строками расхода, поэтому на распределяемую прибыль они не
 * влияют — но верхняя строка совпадает с суммой оплаченных заказов в Shopify, и расчёт
 * можно сверить, не держа в голове, что из него молча выкинуто.
 *
 * Чаевые целиком принадлежат владельцу и в базу доли не входят — это не изменилось,
 * изменилось только то, что вычитание стало видимым.
 *
 * Налог входит в выручку и вычитается целиком у флориста: так одна формула обслуживает и
 * базу флориста (100% налога — расход), и представление владельца с его долей.
 *
 * У непросчитываемого заказа распределяемая прибыль равна нулю, но зарезервированная доля
 * закупки сохраняется — это и есть нераспределённый остаток дня.
 */
export function computeOrderSnapshot(
  input: OrderCalcInput,
  allocatedFlowerCents: number | null,
  /** Доля налога, считающаяся расходом. 10000 = 100% (база флориста). */
  taxExpenseShareBp = 10000
): OrderSnapshotResult {
  const missing: MissingInput[] = [];

  const flower = flowerRevenueCents(input.items);
  if (flower == null) missing.push("FLOWER_REVENUE");
  if (input.deliveryActualCents == null) missing.push("DELIVERY_ACTUAL_COST");
  if (input.acquiringFee == null) missing.push("ACQUIRING_FEE");
  if (input.vaseGiftCostCents == null) missing.push("VASE_GIFT_COST");
  if (input.consumables == null) missing.push("CONSUMABLES_RATE");
  if (allocatedFlowerCents == null) missing.push("DAILY_FLOWER_EXPENSE");

  const grossRevenueCents =
    input.itemsTotalCents + input.taxCents + input.deliveryCustomerCents + input.tipCents;
  const taxExpenseCents = Math.round((input.taxCents * taxExpenseShareBp) / 10000);

  const deliveryActual = input.deliveryActualCents ?? 0;
  const fee = input.acquiringFee?.cents ?? 0;
  const vaseGift = input.vaseGiftCostCents ?? 0;
  const consumables = input.consumables?.cents ?? 0;
  const allocated = allocatedFlowerCents ?? 0;

  const isCalculable = missing.length === 0;
  const distributableCents = isCalculable
    ? grossRevenueCents -
      // Чаевые вычитаются ровно в том размере, в каком вошли в выручку: на итог они не
      // влияют никак, но теперь видно, что они учтены и отданы владельцу.
      input.tipCents -
      taxExpenseCents -
      deliveryActual -
      fee -
      vaseGift -
      consumables -
      allocated -
      input.otherExpenseCents
    : 0;

  return {
    orderId: input.orderId,
    isCalculable,
    missing,
    grossRevenueCents,
    tipsCents: input.tipCents,
    flowerRevenueCents: flower ?? 0,
    taxCents: input.taxCents,
    deliveryActualCents: deliveryActual,
    acquiringFeeCents: fee,
    acquiringFeeSource: input.acquiringFee?.source ?? "ESTIMATED",
    vaseGiftCostCents: vaseGift,
    consumablesCents: consumables,
    allocatedFlowerCents: allocated,
    otherExpenseCents: input.otherExpenseCents,
    distributableCents,
  };
}

export type DayBlocker =
  | "DAILY_FLOWER_EXPENSE_MISSING"
  | "FLOWER_REVENUE_UNDETERMINED"
  /** Хотя бы у одного заказа дня не хватает данных — день не считается целиком. */
  | "ORDER_DATA_INCOMPLETE";

export type DayCalcResult = {
  deliveryDay: string;
  /** Проблемы, из-за которых нельзя считать ВЕСЬ день. */
  blockers: DayBlocker[];
  /** Знаменатель распределения: цветочная выручка всех заказов дня. */
  denominatorCents: number;
  dailyExpenseCents: number | null;
  allocatedCents: number;
  /** Осталось нераспределённым из-за проблемных заказов. */
  unallocatedCents: number;
  orders: OrderSnapshotResult[];
  /** Сумма распределяемой прибыли по заказам, попавшим в расчёт. Может быть отрицательной. */
  distributableTotalCents: number;
};

/**
 * Считает день целиком.
 *
 * Весь день блокируется ровно в двух случаях: нет дневной закупки (распределять нечего)
 * либо цветочную выручку хотя бы одного заказа определить нельзя (знаменатель недостоверен,
 * а посчитать по заведомо неверному знаменателю хуже, чем не считать).
 *
 * Во всех остальных случаях проблемный заказ исключается поштучно, а остальные считаются.
 */
export function computeDay(
  deliveryDay: string,
  orders: OrderCalcInput[],
  dailyExpenseCents: number | null,
  taxExpenseShareBp = 10000
): DayCalcResult {
  const blockers: DayBlocker[] = [];

  const flowerByOrder = orders.map((o) => ({ orderId: o.orderId, flower: flowerRevenueCents(o.items) }));
  const undetermined = flowerByOrder.some((f) => f.flower == null);
  if (undetermined) blockers.push("FLOWER_REVENUE_UNDETERMINED");
  if (dailyExpenseCents == null) blockers.push("DAILY_FLOWER_EXPENSE_MISSING");

  const denominatorCents = flowerByOrder.reduce((a, f) => a + (f.flower ?? 0), 0);

  // Знаменатель — по ВСЕМ заказам дня. Исключённые заказы удерживают свою долю расхода,
  // и она остаётся нераспределённой, а не перекладывается на исправные.
  const allocation =
    blockers.length === 0 && dailyExpenseCents != null
      ? allocateFlowerExpense(
          dailyExpenseCents,
          flowerByOrder.map((f) => ({ orderId: f.orderId, flowerRevenueCents: f.flower ?? 0 }))
        )
      : null;

  if (blockers.length === 0 && allocation == null) {
    // Закупка есть, а распределить не по чему: нулевая цветочная выручка дня.
    blockers.push("FLOWER_REVENUE_UNDETERMINED");
  }

  const results = orders.map((o) =>
    computeOrderSnapshot(o, allocation?.get(o.orderId) ?? null, taxExpenseShareBp)
  );

  /**
   * День считается целиком или не считается вовсе.
   *
   * Раньше незаполненный заказ просто выпадал из дня, а остальные считались — из-за этого
   * сумма появлялась рано и потом менялась: доехали данные — сторно и пересчёт. Флорист
   * успевал увидеть одно число, а получить другое.
   *
   * DAILY_FLOWER_EXPENSE из проверки исключён намеренно: это блокер уровня дня, он уже
   * учтён выше, и пока закупки нет, ВСЕ заказы выглядят неполными — проверка стала бы
   * замкнутой на саму себя.
   */
  const incomplete = results.some((r) => r.missing.some((m) => m !== "DAILY_FLOWER_EXPENSE"));
  if (incomplete) blockers.push("ORDER_DATA_INCOMPLETE");

  const allocatedCents = results.filter((r) => r.isCalculable).reduce((a, r) => a + r.allocatedFlowerCents, 0);
  const unallocatedCents = results.filter((r) => !r.isCalculable).reduce((a, r) => a + r.allocatedFlowerCents, 0);

  return {
    deliveryDay,
    blockers,
    denominatorCents,
    dailyExpenseCents,
    allocatedCents,
    unallocatedCents,
    orders: results,
    // У заблокированного дня распределяемой прибыли нет: показывать частичную сумму
    // значит обещать деньги, которых начисление не создаст.
    distributableTotalCents:
      blockers.length > 0
        ? 0
        : results.filter((r) => r.isCalculable).reduce((a, r) => a + r.distributableCents, 0),
  };
}

/**
 * Начисление основному флористу за день: доля от распределяемой прибыли, не ниже нуля.
 * Отсечка применяется к сумме ДНЯ, а не к отдельному заказу: убыточный заказ гасится
 * прибыльными того же дня, и это осознанно — иначе флорист получал бы долю с хороших
 * заказов, не разделяя плохих.
 */
export function primaryShareCents(distributableTotalCents: number, sharePercentBp: number): number {
  if (distributableTotalCents <= 0) return 0;
  return Math.round((distributableTotalCents * sharePercentBp) / 10000);
}
