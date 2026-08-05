import "server-only";
/**
 * Дашборд владельца: сколько бизнес заработал, сколько отдал флористам и сколько осталось.
 *
 * СЧИТАЕТСЯ НА ЧТЕНИИ, без своей таблицы и без кнопки пересчёта. Замер на проде: месяц
 * целиком — восемь запросов и 20–30 мс, худший месяц за всю историю — 159 заказов. Хранимый
 * агрегат экономил бы эти миллисекунды ценой ещё одного производного значения, способного
 * молча разойтись с источником. Фиксация здесь и не нужна: у флористов число превращается
 * в выплату и потому заморожено, а дашборд владельца никому ничего не должен — если
 * вчерашняя прибыль изменилась оттого, что сегодня подтвердили стоимость доставки, это
 * правильный ответ, а замороженный старый — неправильный.
 *
 * ВТОРОЙ ФОРМУЛЫ ПРИБЫЛИ НЕТ. Вклад заказа считает та же `computeOrderContribution`, что и
 * расчёт дня флориста; отличается только выборка — здесь все заказы, а не одного флориста.
 *
 * Заработок флористов НЕ пересчитывается: доля основного берётся из уже посчитанных строк
 * `DayFinance` (тех же, по которым идут выплаты), фиксированные цены второстепенных — из
 * `Order.floristTotal`. Иначе дашборд мог бы показать одну цифру, а кабинет — другую.
 *
 * Запросов на месяц — константа: ни одного в цикле по дням или заказам.
 */
import { prisma } from "@/lib/db";
import { toNumber } from "@/lib/money";
import { computeDayFinance, dayShareCents, type DayBlocker } from "./dayCalc";
import { toDayOrderInputs } from "./orderInput";
import { loadFinanceSettings } from "./settingsBatch";
import { resolveItemsFinance } from "./itemFinance";
import { primaryShareGate, accrualGate } from "./config";
import { getExpenseDailyTotals } from "@/modules/expenses/read";

export type OwnerDay = {
  day: string;
  /** Все данные на месте — итог дня можно показывать. */
  ready: boolean;
  blockers: DayBlocker[];
  ordersTotal: number;
  /** Доход бизнеса: сколько заплатили клиенты. */
  revenueCents: number;
  /** Доля основного + фиксированные цены второстепенных за этот день. */
  floristEarningsCents: number;
  /** Мои расходы за день из раздела «Мои расходы». */
  ownerExpensesCents: number;
  /** Чистый доход владельца. NULL у неготового дня: частичная сумма — обещание денег. */
  ownerNetCents: number | null;
};

export type OwnerMonth = {
  days: OwnerDay[];
  revenueCents: number;
  floristEarningsCents: number;
  ownerExpensesCents: number;
  /** Сумма по ГОТОВЫМ дням: неготовые в итог не входят и не занижают его молча. */
  ownerNetCents: number;
  readyDays: number;
  incompleteDays: number;
};

const dayKey = (d: Date) => d.toISOString().slice(0, 10);
const toCents = (v: unknown) => Math.round(toNumber(v as never) * 100);

/**
 * Итог по дням за период. `from`/`to` — UTC-полночь первого и последнего дня.
 *
 * Дни без заказов не возвращаются вовсе: список показывает работу, а не календарь.
 */
export async function getOwnerMonth(from: Date, to: Date): Promise<OwnerMonth> {
  const shareGate = primaryShareGate();
  const accrual = accrualGate();

  const orders = await prisma.order.findMany({
    where: { orderStatus: "DELIVERED", deliveryDate: { gte: from, lte: to } },
    select: {
      id: true, orderNumber: true, siteId: true, deliveryDate: true, currentFloristId: true,
      itemsTotal: true, tax: true, tip: true, deliveryCustomerCost: true,
      deliveryActualCost: true, deliveryActualCostConfirmedAt: true, customerTotal: true,
      floristTotal: true,
      acquiringFee: { select: { feeCents: true } },
      consumablesOverride: { select: { amountCents: true } },
      // Снимки типа и закупки нужны позициям ручного заказа: каталога у них нет.
      items: {
        select: {
          id: true, name: true, quantity: true, productId: true, variantId: true,
          financialTypeSnapshot: true, purchaseCostSnapshotCents: true,
        },
      },
    },
  });

  const orderIds = orders.map((o) => o.id);
  const siteIds = [...new Set(orders.map((o) => o.siteId))];

  const [additional, itemFinance, settings, flowerExpenses, dayFinances, profiles, ownerExpenses] =
    await Promise.all([
      prisma.orderAdditionalExpense.findMany({
        where: { orderId: { in: orderIds }, reversedAt: null },
        select: { orderId: true, amountCents: true },
      }),
      resolveItemsFinance(orders.flatMap((o) => o.items)),
      loadFinanceSettings(siteIds),
      prisma.dailyFlowerExpense.findMany({
        where: { expenseDay: { gte: from, lte: to } },
        select: { expenseDay: true, amountCents: true },
      }),
      // Доля основного берётся отсюда — из тех же строк, по которым идут выплаты.
      prisma.dayFinance.findMany({
        where: { day: { gte: from, lte: to }, complete: true },
        select: { day: true, distributableCents: true, financeProfile: { select: { sharePercentBp: true } } },
      }),
      prisma.floristFinanceProfile.findMany({
        where: { active: true, effectiveTo: null },
        select: { floristId: true, model: true },
      }),
      getExpenseDailyTotals(from, to),
    ]);

  const additionalByOrder = new Map<string, number>();
  for (const a of additional) {
    additionalByOrder.set(a.orderId, (additionalByOrder.get(a.orderId) ?? 0) + a.amountCents);
  }
  const modelByFlorist = new Map(profiles.map((p) => [p.floristId, p.model]));
  const flowerByDay = new Map(flowerExpenses.map((f) => [dayKey(f.expenseDay), f.amountCents]));

  // Доля основного: та же отсечка «не ниже нуля» на КАЖДЫЙ день, что и в balance.ts.
  const primaryShareByDay = new Map<string, number>();
  for (const d of dayFinances) {
    const bp = d.financeProfile.sharePercentBp;
    if (bp == null) continue;
    if (shareGate.enabled && d.day < shareGate.startDate) continue;
    const key = dayKey(d.day);
    primaryShareByDay.set(key, (primaryShareByDay.get(key) ?? 0) + dayShareCents(d.distributableCents, bp));
  }

  const ordersByDay = new Map<string, typeof orders>();
  for (const o of orders) {
    const key = dayKey(o.deliveryDate);
    const bucket = ordersByDay.get(key);
    if (bucket) bucket.push(o);
    else ordersByDay.set(key, [o]);
  }

  const days: OwnerDay[] = [];
  for (const [key, dayOrders] of [...ordersByDay.entries()].sort((a, b) => b[0].localeCompare(a[0]))) {
    // Закупка цветов обязательна только когда в этот день работал основной флорист: без его
    // заказов покупать было нечего, и требовать сумму значило бы блокировать день впустую.
    const hasPrimary = dayOrders.some((o) => o.currentFloristId && modelByFlorist.get(o.currentFloristId) === "PRIMARY");
    const flowerCents = flowerByDay.get(key) ?? (hasPrimary ? null : 0);

    const inputs = toDayOrderInputs(dayOrders, { additionalByOrder, itemFinance, settings });
    const calc = computeDayFinance(inputs, flowerCents);

    // Фиксированные цены второстепенных — их заработок за этот день.
    const secondaryCents = dayOrders.reduce((a, o) => {
      if (!o.currentFloristId || modelByFlorist.get(o.currentFloristId) !== "SECONDARY") return a;
      if (accrual.enabled && o.deliveryDate < accrual.startDate) return a;
      return a + Math.max(toCents(o.floristTotal), 0);
    }, 0);

    const floristEarningsCents = (primaryShareByDay.get(key) ?? 0) + secondaryCents;
    const ownerExpensesCents = ownerExpenses.get(key) ?? 0;

    days.push({
      day: key,
      ready: calc.complete,
      blockers: calc.blockers,
      ordersTotal: calc.ordersTotal,
      revenueCents: calc.grossRevenueCents,
      floristEarningsCents,
      ownerExpensesCents,
      ownerNetCents: calc.complete
        ? calc.distributableCents - floristEarningsCents - ownerExpensesCents
        : null,
    });
  }

  return {
    days,
    revenueCents: days.reduce((a, d) => a + d.revenueCents, 0),
    floristEarningsCents: days.reduce((a, d) => a + d.floristEarningsCents, 0),
    ownerExpensesCents: days.reduce((a, d) => a + d.ownerExpensesCents, 0),
    ownerNetCents: days.reduce((a, d) => a + (d.ownerNetCents ?? 0), 0),
    readyDays: days.filter((d) => d.ready).length,
    incompleteDays: days.filter((d) => !d.ready).length,
  };
}
