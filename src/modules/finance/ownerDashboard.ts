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
import { computeDayFinance, dayShareCents, type DayBlocker, type MissingInput } from "./dayCalc";
import { toDayOrderInputs } from "./orderInput";
import { loadFinanceSettings, loadTaxPolicies } from "./settingsBatch";
import { resolveItemsFinance } from "./itemFinance";
import { primaryShareGate, accrualGate } from "./config";
import { getExpenseDailyTotals } from "@/modules/expenses/read";

export type OwnerDay = {
  day: string;
  /** Все данные на месте — итог дня можно показывать. */
  ready: boolean;
  blockers: DayBlocker[];
  /** Что именно не заполнено по заказам — чтобы список говорил, куда идти чинить. */
  missing: MissingInput[];
  ordersTotal: number;
  /** Доход бизнеса: сколько заплатили клиенты. */
  revenueCents: number;
  /** Чаевые — целиком владельца, флористу с них ничего не идёт. */
  tipsCents: number;
  /** Налог, реально уходящий у владельца: уже по доле из «Налоговой политики». */
  ownerTaxCents: number;
  /** Все расходы бизнеса за день, включая мои: выручка − расходы − флористы = прибыль. */
  expensesCents: number;
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
  expensesCents: number;
  floristEarningsCents: number;
  ownerExpensesCents: number;
  /** Сумма по ГОТОВЫМ дням: неготовые в итог не входят и не занижают его молча. */
  ownerNetCents: number;
  readyDays: number;
  incompleteDays: number;
  /** Выручка неготовых дней — она есть, но в итог не попала. Показывается отдельно. */
  pendingRevenueCents: number;
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

  const taxPolicies = await loadTaxPolicies(siteIds);

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

    // Налог здесь сразу по доле владельца: формула одна, вход у неё другой.
    const inputs = toDayOrderInputs(dayOrders, { additionalByOrder, itemFinance, settings, taxShareBp: taxPolicies });
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
      missing: [...new Set(calc.orders.flatMap((o) => o.missing))],
      ordersTotal: calc.ordersTotal,
      revenueCents: calc.grossRevenueCents,
      tipsCents: calc.tipsCents,
      ownerTaxCents: calc.taxCents,
      // Выручка минус прибыль до флористов = всё, что съел день, включая мои расходы.
      // Чаевые в расход не попадают: они вычтены из базы флориста, но остаются у владельца.
      expensesCents: calc.complete
        ? calc.grossRevenueCents - calc.tipsCents - calc.distributableCents + ownerExpensesCents
        : 0,
      floristEarningsCents,
      ownerExpensesCents,
      // Чаевые прибавляются ЗДЕСЬ, а не в distributableCents: та сумма — база доли
      // флориста, и трогать её значило бы изменить чужие деньги.
      ownerNetCents: calc.complete
        ? calc.distributableCents + calc.tipsCents - floristEarningsCents - ownerExpensesCents
        : null,
    });
  }

  // Итог считается ТОЛЬКО по готовым дням — по всем четырём колонкам сразу. Иначе строка
  // итогов не сходится: выручка была бы по всем дням, а прибыль по части, и вычитание
  // одного из другого давало бы число, которого нет. Выручка неготовых дней не теряется,
  // она показывается отдельной строкой.
  const ready = days.filter((d) => d.ready);
  return {
    days,
    revenueCents: ready.reduce((a, d) => a + d.revenueCents, 0),
    expensesCents: ready.reduce((a, d) => a + d.expensesCents, 0),
    floristEarningsCents: ready.reduce((a, d) => a + d.floristEarningsCents, 0),
    ownerExpensesCents: ready.reduce((a, d) => a + d.ownerExpensesCents, 0),
    ownerNetCents: ready.reduce((a, d) => a + (d.ownerNetCents ?? 0), 0),
    readyDays: ready.length,
    incompleteDays: days.length - ready.length,
    pendingRevenueCents: days.filter((d) => !d.ready).reduce((a, d) => a + d.revenueCents, 0),
  };
}

export type OwnerDayDetail = {
  day: string;
  ready: boolean;
  blockers: DayBlocker[];
  /** Что именно не заполнено по заказам — чтобы список говорил, куда идти чинить. */
  missing: MissingInput[];
  /**
   * Заказы, из-за которых день не считается, — с номерами и тем, чего в каждом не хватает.
   *
   * Без номеров сообщение «по заказам не хватает данных» отправляло владельца искать виновника
   * вручную среди всех заказов дня: система знает ответ, но не называет его.
   */
  incompleteOrders: { id: string; orderNumber: string; missing: MissingInput[] }[];
  ordersTotal: number;

  /** Выручка по магазинам — первый вопрос «откуда деньги». */
  revenueBySite: { siteId: string; name: string; cents: number }[];
  revenueCents: number;
  tipsCents: number;
  /** Сколько налога собрано с клиентов — для пояснения к строке расхода. */
  taxCollectedCents: number;

  /** Расходы бизнеса по видам. Порядок фиксированный, нули не скрываются. */
  expenses: { label: string; cents: number }[];
  expensesCents: number;
  ownerExpensesCents: number;

  /** Заработок флористов с их заказами — чтобы было видно, из чего он сложился. */
  florists: {
    floristId: string;
    name: string;
    cents: number;
    orders: { id: string; orderNumber: string; contributionCents: number }[];
  }[];
  floristEarningsCents: number;

  ownerNetCents: number | null;
};

/**
 * Разбор одного дня: из чего сложилась прибыль.
 *
 * Считает тем же способом, что и список дней, — просто не сворачивает результат в три
 * числа. Отдельной формулы здесь нет и быть не должно: расхождение между списком и
 * разбором читалось бы как ошибка в деньгах.
 */
export async function getOwnerDay(day: Date): Promise<OwnerDayDetail | null> {
  const month = await getOwnerMonth(day, day);
  const row = month.days[0];
  if (!row) return null;

  const shareGate = primaryShareGate();
  const accrual = accrualGate();

  const [orders, sites, profiles, flowerExpense, dayFinances] = await Promise.all([
    prisma.order.findMany({
      where: { orderStatus: "DELIVERED", deliveryDate: day },
      select: {
        id: true, orderNumber: true, siteId: true, currentFloristId: true,
        itemsTotal: true, tax: true, tip: true, deliveryCustomerCost: true,
        deliveryActualCost: true, deliveryActualCostConfirmedAt: true, customerTotal: true,
        floristTotal: true,
        acquiringFee: { select: { feeCents: true } },
        consumablesOverride: { select: { amountCents: true } },
        site: { select: { id: true, name: true } },
        currentFlorist: { select: { id: true, user: { select: { name: true } } } },
        items: {
          select: {
            id: true, name: true, quantity: true, productId: true, variantId: true,
            financialTypeSnapshot: true, purchaseCostSnapshotCents: true,
          },
        },
      },
    }),
    prisma.site.findMany({ select: { id: true, name: true } }),
    prisma.floristFinanceProfile.findMany({
      where: { active: true, effectiveTo: null },
      select: { floristId: true, model: true },
    }),
    prisma.dailyFlowerExpense.findFirst({ where: { expenseDay: day }, select: { amountCents: true } }),
    prisma.dayFinance.findMany({
      where: { day, complete: true },
      select: { distributableCents: true, financeProfile: { select: { sharePercentBp: true, floristId: true } } },
    }),
  ]);

  const [additional, itemFinance, settings] = await Promise.all([
    prisma.orderAdditionalExpense.findMany({
      where: { orderId: { in: orders.map((o) => o.id) }, reversedAt: null },
      select: { orderId: true, amountCents: true },
    }),
    resolveItemsFinance(orders.flatMap((o) => o.items)),
    loadFinanceSettings([...new Set(orders.map((o) => o.siteId))]),
  ]);

  const additionalByOrder = new Map<string, number>();
  for (const a of additional) {
    additionalByOrder.set(a.orderId, (additionalByOrder.get(a.orderId) ?? 0) + a.amountCents);
  }
  const taxPolicies = await loadTaxPolicies([...new Set(orders.map((o) => o.siteId))]);
  const calc = computeDayFinance(
    toDayOrderInputs(orders, { additionalByOrder, itemFinance, settings, taxShareBp: taxPolicies }),
    flowerExpense?.amountCents ?? null
  );
  // Сколько налога собрали с клиентов — это уже не расход, а пояснение к нему.
  const taxCollectedCents = orders.reduce((a, o) => a + toCents(o.tax), 0);
  const contributionByOrder = new Map(calc.orders.map((o) => [o.orderId, o.contributionCents]));
  const orderNumberById = new Map(orders.map((o) => [o.id, o.orderNumber]));
  const incompleteOrders = calc.orders
    .filter((o) => o.missing.length > 0)
    .map((o) => ({ id: o.orderId, orderNumber: orderNumberById.get(o.orderId) ?? o.orderId, missing: o.missing }))
    .sort((a, b) => a.orderNumber.localeCompare(b.orderNumber));

  const siteName = new Map(sites.map((s) => [s.id, s.name]));
  const revenueBySite = new Map<string, number>();
  for (const o of orders) {
    const cents =
      toCents(o.itemsTotal) + toCents(o.tax) + toCents(o.deliveryCustomerCost) + toCents(o.tip);
    revenueBySite.set(o.siteId, (revenueBySite.get(o.siteId) ?? 0) + cents);
  }

  const modelByFlorist = new Map(profiles.map((p) => [p.floristId, p.model]));
  const shareByFlorist = new Map<string, number>();
  for (const d of dayFinances) {
    const bp = d.financeProfile.sharePercentBp;
    if (bp == null) continue;
    if (shareGate.enabled && day < shareGate.startDate) continue;
    shareByFlorist.set(d.financeProfile.floristId, dayShareCents(d.distributableCents, bp));
  }

  const byFlorist = new Map<string, OwnerDayDetail["florists"][number]>();
  for (const o of orders) {
    if (!o.currentFloristId || !o.currentFlorist) continue;
    const entry = byFlorist.get(o.currentFloristId) ?? {
      floristId: o.currentFloristId,
      name: o.currentFlorist.user.name ?? "Без имени",
      cents: 0,
      orders: [],
    };
    entry.orders.push({
      id: o.id,
      orderNumber: o.orderNumber,
      contributionCents: contributionByOrder.get(o.id) ?? 0,
    });
    byFlorist.set(o.currentFloristId, entry);
  }
  // Гейт проверяется на сам день: заказы внутри дня все одной даты.
  const beforeAccrual = accrual.enabled && day < accrual.startDate;
  for (const [floristId, entry] of byFlorist) {
    if (beforeAccrual) {
      entry.cents = 0;
    } else if (modelByFlorist.get(floristId) === "PRIMARY") {
      entry.cents = shareByFlorist.get(floristId) ?? 0;
    } else {
      entry.cents = orders
        .filter((o) => o.currentFloristId === floristId)
        .reduce((a, o) => a + Math.max(toCents(o.floristTotal), 0), 0);
    }
  }

  return {
    day: row.day,
    ready: row.ready,
    blockers: row.blockers,
    missing: row.missing,
    incompleteOrders,
    ordersTotal: row.ordersTotal,
    revenueBySite: [...revenueBySite.entries()]
      .map(([siteId, cents]) => ({ siteId, name: siteName.get(siteId) ?? siteId, cents }))
      .sort((a, b) => b.cents - a.cents),
    revenueCents: row.revenueCents,
    tipsCents: row.tipsCents,
    taxCollectedCents,
    expenses: [
      { label: "Цветы", cents: calc.flowerPurchaseCents },
      { label: "Доставка", cents: calc.deliveryCents },
      { label: "Комиссии", cents: calc.acquiringFeeCents },
      { label: "Налог", cents: row.ownerTaxCents },
      { label: "Вазы и подарки", cents: calc.vaseGiftCostCents },
      { label: "Расходники", cents: calc.consumablesCents },
      { label: "Доп. расходы", cents: calc.additionalCents },
      { label: "Мои расходы", cents: row.ownerExpensesCents },
    ],
    expensesCents: row.expensesCents,
    ownerExpensesCents: row.ownerExpensesCents,
    florists: [...byFlorist.values()].sort((a, b) => b.cents - a.cents),
    floristEarningsCents: row.floristEarningsCents,
    ownerNetCents: row.ownerNetCents,
  };
}
