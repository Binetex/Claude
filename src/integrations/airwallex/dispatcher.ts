import "server-only";
import type { PrismaClient } from "@/generated/prisma/client";
import { publishAirwallexVerify } from "./events";

/**
 * Диспетчер опроса: раз в 5 минут ОДИН индексированный SELECT по
 * (siteId, monitoringActive, nextCheckAt) и постановка задач в существующий outbox.
 * Полного скана заказов нет; отдельного планировщика/воркера тоже — работает в текущем воркере.
 *
 * Дедуп между экземплярами воркера обеспечивает идемпотентность outbox (ключ включает слот
 * nextCheckAt), поэтому явная блокировка строк не нужна.
 */
export const DISPATCH_LIMIT = 50;

export async function dispatchAirwallexChecks(prisma: PrismaClient, now: Date = new Date()): Promise<{ selected: number; enqueued: number }> {
  // Сайты с включённым мониторингом — обычно один-два, поэтому фильтр по siteId дешёвый.
  const sites = await prisma.wooCommerceConnection.findMany({
    where: { airwallexMonitoringEnabled: true },
    select: { siteId: true },
  });
  if (sites.length === 0) return { selected: 0, enqueued: 0 };

  const due = await prisma.airwallexPayment.findMany({
    where: {
      siteId: { in: sites.map((s) => s.siteId) },
      monitoringActive: true,
      nextCheckAt: { not: null, lte: now },
      paymentIntentId: { not: null },
    },
    select: { orderId: true, nextCheckAt: true },
    orderBy: { nextCheckAt: "asc" },
    take: DISPATCH_LIMIT,
  });

  let enqueued = 0;
  for (const d of due) {
    const { created } = await publishAirwallexVerify(prisma, d.orderId, d.nextCheckAt);
    if (created) enqueued++;
  }
  return { selected: due.length, enqueued };
}
