/**
 * Резолвер контекста уведомления о доставке из БД. Отдаётся worker'у как зависимость
 * handler'а `order.delivery.completed`. Читает ТОЛЬКО необходимые поля заказа (номер и
 * контакты отправителя) — не тянет весь заказ и не логирует PII.
 *
 * Тип Prisma импортируется только как type (стирается) — модуль не серверно-эксклюзивен и
 * не тянет рантайм-зависимостей; конкретный клиент передаётся параметром.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import type { DeliveryNotifyContext } from "./handlers";

export function createDeliveryResolver(
  prisma: PrismaClient
): (orderId: string) => Promise<DeliveryNotifyContext | null> {
  return async (orderId: string) => {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: { orderNumber: true, senderPhone: true, senderEmail: true },
    });
    if (!order) return null;
    return {
      orderNumber: order.orderNumber,
      senderPhone: order.senderPhone?.trim() ? order.senderPhone : null,
      senderEmail: order.senderEmail?.trim() ? order.senderEmail : null,
      // Telegram/push для отправителя заказа пока не хранятся в модели Order — null.
      // Появятся вместе с полями подписок (см. docs/PROPOSED_SCHEMA_CHANGES.md).
      senderTelegramId: null,
      senderPushToken: null,
    };
  };
}
