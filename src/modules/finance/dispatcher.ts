import "server-only";
/**
 * Диспетчер начислений: находит доставленные заказы, за которые ещё ничего не записано
 * в книгу, и ставит задачи в существующий outbox.
 *
 * Почему это ОСНОВНОЙ путь, а не подстраховка. Событие «заказ доставлен» публикуется
 * только из «живых» путей приёма, и на практике платформенный источник не срабатывает
 * (курьер отмечает доставку раньше магазина — см. CLAUDE.md), а ручная отметка владельца
 * до этого этапа вообще ничего не публиковала. Полагаться на одну публикацию значит
 * молча терять начисления, а это деньги живых людей.
 *
 * Стоимость запроса: один индексированный SELECT по (orderStatus, deliveryDate) с LIMIT.
 * Полного скана заказов нет; отдельного планировщика нет — тот же воркер, тот же outbox.
 *
 * ВАЖНО про повторы. Ключ события — сам заказ, поэтому задача ставится РОВНО ОДИН РАЗ за
 * всю жизнь заказа. Если начисление тогда не прошло (не задана цена, нет профиля), само
 * оно потом не «дозреет»: заказ висит в очереди разбора, и владелец запускает начисление
 * кнопкой. Это сделано намеренно — молча начислять задним числом по изменившимся условиям
 * хуже, чем показать список и дать решить.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { PrismaOutboxRepository } from "@/outbox/prismaRepository";
import { publishAccrualRequest } from "./events";
import { accrualGate } from "./config";

export const DISPATCH_LIMIT = 100;

export type DispatchResult = { selected: number; enqueued: number; skipped?: string };

export async function dispatchFinanceAccruals(
  prisma: PrismaClient,
  now: Date = new Date()
): Promise<DispatchResult> {
  const gate = accrualGate();
  if (!gate.enabled) return { selected: 0, enqueued: 0, skipped: gate.reason };

  const due = await prisma.order.findMany({
    where: {
      orderStatus: "DELIVERED",
      deliveryDate: { gte: gate.startDate, lte: now },
      // Назначенный флорист — и есть признак реальной работы. По `isBackfilled` здесь
      // НЕ фильтруем: этот флаг говорит, как запись заказа попала в базу, а не о том,
      // делал ли кто-то букет. Заказ, подтянутый историческим скриптом и потом назначенный
      // флористу вручную, — обычная работа, и не заплатить за неё было бы ошибкой.
      currentFloristId: { not: null },
      // Ни одной записи в книге по этому заказу — включая уже созданное начисление
      // и ручное решение владельца. Оба означают «разобрано».
      ledgerEntries: { none: {} },
    },
    select: { id: true },
    orderBy: { deliveryDate: "asc" },
    take: DISPATCH_LIMIT,
  });
  if (due.length === 0) return { selected: 0, enqueued: 0 };

  const repo = new PrismaOutboxRepository(prisma);
  let enqueued = 0;
  for (const order of due) {
    const { created } = await publishAccrualRequest(repo, order.id);
    if (created) enqueued++;
  }
  return { selected: due.length, enqueued };
}
