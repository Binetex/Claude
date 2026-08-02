import "server-only";
/**
 * Точки, из которых финансовый модуль узнаёт об изменениях заказа.
 *
 * Все хуки best-effort: сбой публикации логируется, но НЕ ломает основную операцию —
 * приём заказа или смену статуса. Потерянную задачу подберёт диспетчер (см. dispatcher.ts),
 * поэтому единственное последствие сбоя — задержка, а не потерянные деньги.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { PrismaOutboxRepository } from "@/outbox/prismaRepository";
import { publishAccrualRequest } from "./events";
import { accrualGate } from "./config";
import { reaccrueOrder, backgroundActor } from "./accrual";
import type { LedgerActor } from "./ledger";

/**
 * Заказ стал доставленным — поставить задачу на начисление.
 * Вызывать из ЛЮБОГО пути, приводящего к DELIVERED: платформа, курьер, ручная отметка.
 * Двойной вызов безвреден: событие дедуплицируется по заказу, а начисление — по своему ключу.
 */
export async function onOrderDeliveredSafe(prisma: PrismaClient, orderId: string): Promise<void> {
  try {
    if (!accrualGate().enabled) return;
    await publishAccrualRequest(new PrismaOutboxRepository(prisma), orderId);
  } catch (err) {
    console.error(
      `[finance] onOrderDelivered failed for order ${orderId}:`,
      err instanceof Error ? err.message : String(err)
    );
  }
}

/**
 * Владелец изменил цену флориста или переназначил заказ. Если по заказу уже есть
 * начисление, оно сторнируется и создаётся новое — историю не переписываем.
 *
 * Тихо ничего не делает, пока начислений по заказу нет: до доставки менять цену — норма.
 */
export async function onFloristPriceChangedSafe(
  orderId: string,
  reason: string,
  actor?: LedgerActor
): Promise<void> {
  try {
    const who = actor ?? (await backgroundActor());
    if (!who) return;
    await reaccrueOrder(orderId, who, reason);
  } catch (err) {
    console.error(
      `[finance] onFloristPriceChanged failed for order ${orderId}:`,
      err instanceof Error ? err.message : String(err)
    );
  }
}
