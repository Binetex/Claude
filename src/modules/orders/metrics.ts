import "server-only";
import { prisma } from "@/lib/db";
import { DEFAULT_STORE_TZ, utcDayRangeForLocalToday } from "@/lib/tz";
import { toNumber } from "@/lib/money";
import { computeEstimatedProfit } from "@/modules/pricing/profit";
import { effectiveFloristTotal } from "@/modules/pricing/serviceItems";
import { TERMINAL_ORDER_STATUSES, IN_WORK_ORDER_STATUSES } from "@/lib/statuses";
import type { OrderStatus } from "@/generated/prisma/enums";

// Требуют назначения: не ждут оплаты и не терминальные (выполнен/отменён).
const NOT_NEEDING_ASSIGNMENT: OrderStatus[] = ["AWAITING_PAYMENT", ...TERMINAL_ORDER_STATUSES];

export async function getOwnerDashboard() {
  // «Сегодня»/«завтра» — по КАЛЕНДАРНОМУ дню в таймзоне бизнеса (все магазины — LA), а НЕ по
  // серверному времени: иначе у границы суток (в UTC уже завтра, а в LA ещё сегодня) счётчики
  // уплывают на день. deliveryDate хранится как UTC-полночь локального дня, поэтому сравниваем
  // с UTC-диапазоном соответствующего локального дня.
  //
  // TODO(multi-tz): пока все магазины в одной зоне (LA), поэтому считаем глобально по DEFAULT_STORE_TZ.
  // Когда появятся магазины в РАЗНЫХ часовых поясах, «Сегодня/Завтра» надо считать ПОФАЙЛОВО по
  // Site.timezone каждого магазина и суммировать (единый глобальный день тогда некорректен на границе
  // суток). Готовый чистый примитив для этого — lib/tz.deliveryDayBucket(deliveryDate, site.timezone)
  // (покрыт тестом); реализация: сгруппировать заказы по site.timezone → классифицировать → сумма.
  const today = utcDayRangeForLocalToday(DEFAULT_STORE_TZ);
  const tomorrow = { gte: today.lt, lt: new Date(today.lt.getTime() + 24 * 60 * 60 * 1000) };

  const [
    ordersToday,
    ordersTomorrow,
    unassigned,
    inProgress,
    ready,
    inTransit,
    deliveredToday,
    financeToday,
    ordersWithTipInPriceToday,
  ] = await Promise.all([
    prisma.order.count({ where: { deliveryDate: { gte: today.gte, lt: today.lt } } }),
    prisma.order.count({ where: { deliveryDate: { gte: tomorrow.gte, lt: tomorrow.lt } } }),
    prisma.order.count({ where: { assignmentStatus: "UNASSIGNED", orderStatus: { notIn: NOT_NEEDING_ASSIGNMENT } } }),
    // «В работе» = вся группа статусов у флориста. Считать один IN_PROGRESS нельзя: назначение
    // с авто-принятием ставит FLORIST_ACCEPTED, поэтому счётчик всегда показывал ноль.
    prisma.order.count({ where: { orderStatus: { in: IN_WORK_ORDER_STATUSES } } }),
    prisma.order.count({ where: { orderStatus: "READY" } }),
    prisma.order.count({ where: { orderStatus: "IN_TRANSIT" } }),
    prisma.order.count({ where: { orderStatus: "DELIVERED", deliveryDate: { gte: today.gte, lt: today.lt } } }),
    // estimatedProfit НЕ суммируем: поле обновляется только при назначении флориста и
    // устаревает. Прибыль считаем из составляющих той же формулой, что и карточка заказа.
    prisma.order.aggregate({
      where: { deliveryDate: { gte: today.gte, lt: today.lt }, paymentStatus: "PAID" },
      _sum: {
        customerTotal: true, floristTotal: true, deliveryActualCost: true,
        itemsTotal: true, tax: true, tip: true, deliveryCustomerCost: true,
      },
    }),
    // Заказы этого дня, где чаевые попали в снимок цены флориста. Сумма floristTotal выше
    // берётся одним агрегатом, поэтому поправку считаем отдельно и вычитаем — так
    // исторические заказы не завышают расходы на флористов и не занижают прибыль.
    // Правило поправки то же, что в карточке заказа (effectiveFloristTotal), поэтому берём
    // заказ целиком: по одной позиции решить нельзя. Кандидатов мало — только заказы дня.
    prisma.order.findMany({
      where: {
        deliveryDate: { gte: today.gte, lt: today.lt },
        paymentStatus: "PAID",
        items: { some: { productId: null, variantId: null, floristItemPrice: { gt: 0 } } },
      },
      select: {
        floristTotal: true,
        items: { select: { name: true, productId: true, variantId: true, floristItemPrice: true } },
      },
    }),
  ]);

  const tipFloristCostToday = ordersWithTipInPriceToday.reduce((acc, o) => {
    const stored = toNumber(o.floristTotal);
    const items = o.items.map((i) => ({ ...i, floristItemPrice: toNumber(i.floristItemPrice) }));
    return acc + (stored - effectiveFloristTotal(stored, items));
  }, 0);
  const floristCostToday = Math.round((toNumber(financeToday._sum.floristTotal) - tipFloristCostToday) * 100) / 100;

  const attention = await prisma.order.findMany({
    where: { OR: [{ assignmentStatus: "UNASSIGNED", orderStatus: { notIn: NOT_NEEDING_ASSIGNMENT } }, { orderStatus: "PROBLEM" }] },
    include: { site: true, currentFlorist: { include: { user: true } } },
    orderBy: { deliveryDate: "asc" },
    take: 10,
  });

  const upcoming = await prisma.order.findMany({
    where: { deliveryDate: { gte: today.gte }, orderStatus: { notIn: ["DELIVERED", "CANCELLED"] } },
    include: { site: true, currentFlorist: { include: { user: true } } },
    orderBy: { deliveryDate: "asc" },
    take: 8,
  });

  return {
    metrics: {
      ordersToday,
      ordersTomorrow,
      unassigned,
      inProgress,
      ready,
      inTransit,
      deliveredToday,
      revenueToday: toNumber(financeToday._sum.customerTotal),
      floristCostToday,
      deliveryCostToday: toNumber(financeToday._sum.deliveryActualCost),
      profitToday: computeEstimatedProfit({
        itemsTotal: toNumber(financeToday._sum.itemsTotal),
        tax: toNumber(financeToday._sum.tax),
        tip: toNumber(financeToday._sum.tip),
        deliveryCustomerCost: toNumber(financeToday._sum.deliveryCustomerCost),
        floristTotal: floristCostToday,
        deliveryActualCost: toNumber(financeToday._sum.deliveryActualCost),
      }),
    },
    attention: attention.map((o) => ({
      id: o.id,
      orderNumber: o.orderNumber,
      siteName: o.site.name,
      colorTag: o.site.colorTag,
      deliveryDate: o.deliveryDate,
      recipientName: o.recipientName,
      orderStatus: o.orderStatus,
      paymentFailed: o.externalStatus === "failed" || o.paymentClassification === "PAYMENT_FAILED",
      assignmentStatus: o.assignmentStatus,
      florist: o.currentFlorist?.user.name ?? null,
    })),
    upcoming: upcoming.map((o) => ({
      id: o.id,
      orderNumber: o.orderNumber,
      siteName: o.site.name,
      colorTag: o.site.colorTag,
      deliveryDate: o.deliveryDate,
      deliveryWindow: o.deliveryWindow,
      recipientName: o.recipientName,
      orderStatus: o.orderStatus,
      paymentFailed: o.externalStatus === "failed" || o.paymentClassification === "PAYMENT_FAILED",
      florist: o.currentFlorist?.user.name ?? null,
    })),
  };
}
