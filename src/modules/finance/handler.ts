import "server-only";
/**
 * Обработчик задачи начисления. Вся логика и все проверки — в accrueOrder; здесь только
 * разбор payload и лог результата.
 *
 * Пропуск (нет флориста, не задана цена, нет профиля) — НЕ ошибка задачи: повторять
 * бессмысленно, состояние изменится только действием владельца. Поэтому задача
 * завершается успешно, а заказ остаётся в очереди разбора.
 */
import type { OutboxHandler } from "@/outbox/worker";
import type { OutboxRecord } from "@/outbox/types";
import { accrueOrder, backgroundActor } from "./accrual";
import type { FinanceAccrualPayload } from "./events";

export function buildFinanceAccrualHandler(): OutboxHandler {
  return async (record: OutboxRecord) => {
    const p = record.payload as FinanceAccrualPayload;
    if (!p?.orderId) return;

    const actor = await backgroundActor();
    if (!actor) {
      // Без владельца автора записи не существует. Это поломка конфигурации, а не
      // бизнес-случай — пусть outbox повторит.
      throw new Error("[finance] не найден активный OWNER — некому приписать начисление");
    }

    const outcome = await accrueOrder(p.orderId, actor);
    if (outcome.status === "CREATED") {
      console.info(`[finance] accrual created for order ${p.orderId}: ${outcome.amountCents} cents`);
    } else if (outcome.status === "SKIPPED") {
      console.info(`[finance] accrual skipped for order ${p.orderId}: ${outcome.reason}`);
    }
  };
}
