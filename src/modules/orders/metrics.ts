import "server-only";
import { prisma } from "@/lib/db";
import { DEFAULT_STORE_TZ, utcDayRangeForLocalToday } from "@/lib/tz";
import { toNumber } from "@/lib/money";
import { TERMINAL_ORDER_STATUSES } from "@/lib/statuses";
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
    awaitingAccept,
    inProgress,
    ready,
    inTransit,
    deliveredToday,
    financeToday,
  ] = await Promise.all([
    prisma.order.count({ where: { deliveryDate: { gte: today.gte, lt: today.lt } } }),
    prisma.order.count({ where: { deliveryDate: { gte: tomorrow.gte, lt: tomorrow.lt } } }),
    prisma.order.count({ where: { assignmentStatus: "UNASSIGNED", orderStatus: { notIn: NOT_NEEDING_ASSIGNMENT } } }),
    prisma.order.count({ where: { assignmentStatus: "ASSIGNED" } }),
    prisma.order.count({ where: { orderStatus: "IN_PROGRESS" } }),
    prisma.order.count({ where: { orderStatus: "READY" } }),
    prisma.order.count({ where: { orderStatus: "IN_TRANSIT" } }),
    prisma.order.count({ where: { orderStatus: "DELIVERED", deliveryDate: { gte: today.gte, lt: today.lt } } }),
    prisma.order.aggregate({
      where: { deliveryDate: { gte: today.gte, lt: today.lt }, paymentStatus: "PAID" },
      _sum: { customerTotal: true, floristTotal: true, deliveryActualCost: true, estimatedProfit: true },
    }),
  ]);

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
      awaitingAccept,
      inProgress,
      ready,
      inTransit,
      deliveredToday,
      revenueToday: toNumber(financeToday._sum.customerTotal),
      floristCostToday: toNumber(financeToday._sum.floristTotal),
      deliveryCostToday: toNumber(financeToday._sum.deliveryActualCost),
      profitToday: toNumber(financeToday._sum.estimatedProfit),
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
