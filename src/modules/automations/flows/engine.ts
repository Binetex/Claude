import "server-only";
/**
 * Ядро цепочек: старт run'а по факту триггера и продвижение к следующему шагу.
 *
 * Модель исполнения намеренно однородная: КАЖДЫЙ шаг (включая WAIT) получает свою строку
 * AutomationFlowRunStep и своё outbox-событие. WAIT просто планируется на «сейчас + задержка»
 * и при срабатывании сразу отмечается выполненным, продвигая цепочку дальше. За это платим
 * одним лишним событием на WAIT, зато и история («шаг 1 WAIT — выполнен тогда-то»), и код
 * продвижения остаются простыми: ровно один следующий шаг, ровно одно событие.
 *
 * Идемпотентность:
 *  - unique(flowId, orderId) — на заказ приходится не больше одного run'а данной цепочки,
 *    даже если факт триггера придёт повторно или из другого источника;
 *  - unique(runId, stepId)   — шаг run'а материализуется ровно один раз;
 *  - dedup outbox по `flow.step:{runStepId}` — на шаг приходится одно событие.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import type { OutboxRepository } from "@/outbox/types";
import { computeScheduledAt, type SmsDelayUnit } from "../delay";
import { publishFlowStep } from "./events";
import { isP2002 } from "@/lib/prismaErrors";

/** Шаг цепочки в объёме, нужном движку (не тащим весь Prisma-объект в сигнатуры). */
export type FlowStepRow = {
  id: string;
  position: number;
  type: "WAIT" | "EMAIL" | "SMS";
  waitAmount: number | null;
  waitUnit: string | null;
  deletedAt: Date | null;
};

export type FlowForStart = {
  id: string;
  steps: FlowStepRow[];
};

/** Канал шага для истории/маршрутизации отправки. У WAIT канала нет. */
export function channelOfStepType(type: FlowStepRow["type"]): string | null {
  return type === "WAIT" ? null : type;
}

/** Следующий живой шаг после указанной позиции. Удалённые (soft) шаги пропускаются. */
export function nextStepAfter(steps: FlowStepRow[], afterPosition: number): FlowStepRow | null {
  const ordered = [...steps].sort((a, b) => a.position - b.position);
  return ordered.find((s) => s.position > afterPosition && !s.deletedAt) ?? null;
}

/**
 * Планирует следующий шаг run'а либо завершает run, если шагов больше нет.
 * Вызывается и при старте (afterPosition = 0), и после выполнения каждого шага.
 */
export async function advanceRun(
  prisma: PrismaClient,
  repo: OutboxRepository,
  args: { runId: string; orderId: string; steps: FlowStepRow[]; afterPosition: number; now?: Date }
): Promise<void> {
  const now = args.now ?? new Date();
  const next = nextStepAfter(args.steps, args.afterPosition);

  if (!next) {
    await prisma.automationFlowRun.update({
      where: { id: args.runId },
      data: { status: "COMPLETED", currentStepId: null, nextRunAt: null, finishedAt: now },
    });
    return;
  }

  // WAIT откладывает сам себя; шаги-сообщения выполняются сразу, как только до них дошла очередь.
  const scheduledAt =
    next.type === "WAIT" ? computeScheduledAt(now, next.waitAmount ?? 0, (next.waitUnit ?? "IMMEDIATE") as SmsDelayUnit) : now;

  let runStepId: string | null = null;
  try {
    const created = await prisma.automationFlowRunStep.create({
      data: {
        runId: args.runId,
        stepId: next.id,
        position: next.position,
        type: next.type,
        scheduledAt,
        channel: channelOfStepType(next.type),
      },
      select: { id: true },
    });
    runStepId = created.id;
  } catch (err) {
    if (!isP2002(err)) throw err;
    // Гонка: шаг уже материализован другим проходом — берём его и ничего не дублируем.
    const existing = await prisma.automationFlowRunStep.findUnique({
      where: { runId_stepId: { runId: args.runId, stepId: next.id } },
      select: { id: true },
    });
    runStepId = existing?.id ?? null;
  }
  if (!runStepId) return;

  await prisma.automationFlowRun.update({
    where: { id: args.runId },
    data: { currentStepId: next.id, nextRunAt: scheduledAt },
  });
  await publishFlowStep(repo, { runStepId, orderId: args.orderId }, scheduledAt);
}

/**
 * Стартует цепочки по факту триггера. `flows` уже отобраны trigger-обработчиком по
 * (магазин, событие, active) — здесь только создание run'ов и планирование первого шага.
 *
 * Цепочка без живых шагов run не создаёт: планировать нечего, а пустая история только мешает.
 */
export async function startFlowsForTrigger(
  prisma: PrismaClient,
  repo: OutboxRepository,
  args: { flows: FlowForStart[]; orderId: string; siteId: string; now?: Date }
): Promise<void> {
  for (const flow of args.flows) {
    const steps = flow.steps.filter((s) => !s.deletedAt);
    if (steps.length === 0) continue;

    let runId: string | null = null;
    try {
      const run = await prisma.automationFlowRun.create({
        data: { flowId: flow.id, orderId: args.orderId, siteId: args.siteId },
        select: { id: true },
      });
      runId = run.id;
    } catch (err) {
      if (isP2002(err)) continue; // run по этому заказу уже есть — второй цепочки не будет
      throw err;
    }

    await advanceRun(prisma, repo, { runId, orderId: args.orderId, steps: flow.steps, afterPosition: 0, now: args.now });
  }
}
