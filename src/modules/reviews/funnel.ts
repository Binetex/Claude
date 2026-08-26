import "server-only";
/**
 * Сводка воронки для владельца: сколько запросов на каком шаге и где они теряются.
 *
 * Считается прямой группировкой по статусу — своей арифметики здесь нет и заводить её не надо:
 * статус и есть шаг воронки, а «сколько дошло» это просто счёт строк.
 */
import { prisma } from "@/lib/db";
import type { ReviewRequestStatus } from "@/generated/prisma/client";

export type FunnelCounts = Record<ReviewRequestStatus, number> & { total: number; overdue: number };

const ZERO: Record<string, number> = {
  NEW: 0, CALLING: 0, LINK_SENT: 0, PROMISED: 0, FORGOT: 0,
  READY_TO_CHECK: 0, CONFIRMED: 0, DECLINED: 0, GAVE_UP: 0,
};

export async function getFunnelCounts(now = new Date()): Promise<FunnelCounts> {
  const [rows, overdue] = await Promise.all([
    prisma.orderReviewRequest.groupBy({ by: ["status"], _count: { _all: true } }),
    // Просрочка — только там, где ход за ОПЕРАТОРОМ. У «обещал оставить» срок означает «пора
    // напомнить», и занимается этим система: считать его просрочкой значило бы показывать
    // владельцу тревогу там, где всё идёт по плану.
    prisma.orderReviewRequest.count({
      where: { status: { in: ["NEW", "CALLING"] }, nextActionAt: { lt: startOfToday(now) } },
    }),
  ]);

  const counts = { ...ZERO };
  let total = 0;
  for (const r of rows) {
    counts[r.status] = r._count._all;
    total += r._count._all;
  }
  return { ...(counts as Record<ReviewRequestStatus, number>), total, overdue };
}

/** Последние запросы — лента для владельца, чтобы видеть движение, а не только числа. */
export async function listRecentRequests(limit = 40) {
  return prisma.orderReviewRequest.findMany({
    select: {
      id: true,
      status: true,
      nextActionAt: true,
      confirmedAt: true,
      confirmedVia: true,
      location: { select: { name: true } },
      order: {
        select: { id: true, orderNumber: true, senderName: true, site: { select: { name: true } } },
      },
    },
    orderBy: { updatedAt: "desc" },
    take: limit,
  });
}

function startOfToday(now: Date): Date {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d;
}
