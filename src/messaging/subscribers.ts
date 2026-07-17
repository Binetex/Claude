/**
 * Подписчики уведомлений на доменные события. Провайдеры НЕ зашиты в webhook-хендлеры —
 * событие `order.delivery.completed` фан-аутит в каналы через `MessagingService` и,
 * опционально, запускает completion-sync во внешнюю платформу.
 *
 * Контекст заказа получается через инъектируемый резолвер (в продакшене — из Prisma,
 * в тестах — mock), поэтому модуль не завязан на БД и легко тестируется. Реальная
 * отправка появится, когда за `MessageProvider` встанут настоящие провайдеры (сейчас mock).
 */
import type { EventBus } from "@/events/bus";
import type { MessagingService } from "./service";
import type { MessageCommand } from "./types";

export type OrderNotifyContext = {
  orderNumber: string;
  senderPhone: string | null;
  senderEmail: string | null;
  senderTelegramId: string | null;
};

export type DeliveryNotificationDeps = {
  /** Загрузка данных заказа для уведомления (Prisma в проде, mock в тестах). */
  resolve: (orderId: string) => Promise<OrderNotifyContext | null>;
  /** Необязательный completion-sync во внешнюю платформу (Shopify/Woo). */
  onCompletionSync?: (orderId: string) => Promise<void>;
};

/**
 * Регистрирует фан-аут уведомлений при завершении доставки. Возвращает функцию отписки.
 * Каждый канал получает свой idempotencyKey (производный от ключа события), чтобы повторная
 * доставка события не рассылала дубликаты.
 */
export function registerDeliveryNotifications(
  bus: EventBus,
  service: MessagingService,
  deps: DeliveryNotificationDeps
): () => void {
  return bus.on(
    "order.delivery.completed",
    async ({ orderId }, env) => {
      const ctx = await deps.resolve(orderId);
      if (!ctx) return;

      const base = { templateId: "order.delivery.completed" as const, vars: { orderNumber: ctx.orderNumber } };
      const commands: MessageCommand[] = [];
      if (ctx.senderPhone) {
        commands.push({ ...base, channel: "SMS", to: ctx.senderPhone, idempotencyKey: `${env.idempotencyKey}:sms` });
      }
      if (ctx.senderTelegramId) {
        commands.push({ ...base, channel: "TELEGRAM", to: ctx.senderTelegramId, idempotencyKey: `${env.idempotencyKey}:tg` });
      }
      if (ctx.senderEmail) {
        commands.push({ ...base, channel: "EMAIL", to: ctx.senderEmail, idempotencyKey: `${env.idempotencyKey}:email` });
      }

      if (commands.length) await service.sendMany(commands);
      if (deps.onCompletionSync) await deps.onCompletionSync(orderId);
    },
    "deliveryNotifications"
  );
}
