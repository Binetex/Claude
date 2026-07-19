import "server-only";
/**
 * Реконсиляция расписаний Burq — САМОСТРАХОВКА, а не основной механизм. Основной путь —
 * событийная отложенная задача при сохранении/изменении заказа. Реконсиляция закрывает дыру
 * «Order сохранён → enqueue упал → задача потеряна»: периодически (редко, 1–3ч) находит
 * СЕГОДНЯШНИЕ/просроченные заказы без актуального draft и, если они реально готовы к созданию,
 * пере-ставит задачу.
 *
 * Гарантии:
 *  - НИКОГДА не вызывает Burq API — только `rescheduleDeliveryForOrder` (enqueue в outbox);
 *  - НЕ плодит дубли: пропускает заказы, у которых уже есть ЖИВАЯ (PENDING/PROCESSING) задача
 *    создания; на actionable-заказ без задачи ставит ровно одну;
 *  - НЕ churn'ит ждущие заказы: если заказ не eligible (нет флориста/pickup/выключено) — пропуск,
 *    его перепланирует хук назначения флориста/настройки pickup, когда условие появится.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { isBurqRuntimeEnabled } from "@/lib/featureFlags";
import { BURQ_DRAFT_CREATE_EVENT } from "./schedule";
import { decideDraftEligibility } from "./eligibility";
import { createPrismaDraftPort } from "./draftPort.prisma";
import { rescheduleDeliveryForOrder } from "./scheduleService";
import { TERMINAL_ORDER_STATUSES } from "@/lib/statuses";

function endOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59, 999));
}

export async function reconcileBurqSchedules(prisma: PrismaClient, now: Date = new Date()): Promise<{ scanned: number; rescheduled: number }> {
  if (!isBurqRuntimeEnabled()) return { scanned: 0, rescheduled: 0 }; // master gate: recovery не работает
  // Кандидаты: сегодняшние/просроченные, не терминальные, без текущего draft.
  const candidates = await prisma.order.findMany({
    where: {
      deliveryDate: { lte: endOfUtcDay(now) },
      orderStatus: { notIn: TERMINAL_ORDER_STATUSES },
      deliveries: { none: { isCurrentAttempt: true, externalDeliveryId: { not: null } } },
    },
    select: { id: true },
    take: 500,
  });

  const port = createPrismaDraftPort(prisma);
  let rescheduled = 0;

  for (const { id: orderId } of candidates) {
    // Есть ли ЖИВАЯ задача создания? Тогда не трогаем (она отработает).
    const liveTask = await prisma.outboxEvent.findFirst({
      where: { eventType: BURQ_DRAFT_CREATE_EVENT, aggregateId: orderId, status: { in: ["PENDING", "PROCESSING"] } },
      select: { id: true },
    });
    if (liveTask) continue;

    // Живой задачи нет (потеряна или уже обработана без результата). Ставим заново ТОЛЬКО если
    // заказ реально готов к созданию черновика — иначе он корректно ждёт (без churn).
    const ctx = await port.loadContext(orderId);
    if (!ctx) continue;
    const decision = decideDraftEligibility({
      siteAutoCreateEnabled: ctx.order.siteAutoCreateEnabled,
      orderStatus: ctx.order.orderStatus,
      floristId: ctx.floristId,
      pickup: ctx.pickup,
      hasCurrentDraft: ctx.hasCurrentDraft,
    });
    if (decision.action !== "CREATE_DRAFT") continue;

    await rescheduleDeliveryForOrder(prisma, orderId);
    rescheduled++;
  }

  return { scanned: candidates.length, rescheduled };
}
