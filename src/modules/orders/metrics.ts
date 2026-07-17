import "server-only";
import { prisma } from "@/lib/db";
import { startOfDay, endOfDay, addDays } from "date-fns";
import { toNumber } from "@/lib/money";
import { TERMINAL_ORDER_STATUSES } from "@/lib/statuses";
import type { OrderStatus } from "@/generated/prisma/enums";

// Требуют назначения: не ждут оплаты и не терминальные (выполнен/отменён).
const NOT_NEEDING_ASSIGNMENT: OrderStatus[] = ["AWAITING_PAYMENT", ...TERMINAL_ORDER_STATUSES];

export async function getOwnerDashboard() {
  const now = new Date();
  const todayStart = startOfDay(now);
  const todayEnd = endOfDay(now);
  const tomStart = startOfDay(addDays(now, 1));
  const tomEnd = endOfDay(addDays(now, 1));

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
    prisma.order.count({ where: { deliveryDate: { gte: todayStart, lte: todayEnd } } }),
    prisma.order.count({ where: { deliveryDate: { gte: tomStart, lte: tomEnd } } }),
    prisma.order.count({ where: { assignmentStatus: "UNASSIGNED", orderStatus: { notIn: NOT_NEEDING_ASSIGNMENT } } }),
    prisma.order.count({ where: { assignmentStatus: "ASSIGNED" } }),
    prisma.order.count({ where: { orderStatus: "IN_PROGRESS" } }),
    prisma.order.count({ where: { orderStatus: "READY" } }),
    prisma.order.count({ where: { orderStatus: "IN_TRANSIT" } }),
    prisma.order.count({ where: { orderStatus: "DELIVERED", deliveryDate: { gte: todayStart, lte: todayEnd } } }),
    prisma.order.aggregate({
      where: { deliveryDate: { gte: todayStart, lte: todayEnd }, paymentStatus: "PAID" },
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
    where: { deliveryDate: { gte: todayStart }, orderStatus: { notIn: ["DELIVERED", "CANCELLED"] } },
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
      florist: o.currentFlorist?.user.name ?? null,
    })),
  };
}
