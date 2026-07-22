import "server-only";
/** Общий маппер Prisma-заказа (+Site) в срез переменных шаблона. Используют handler и preview. */
import type { Prisma } from "@/generated/prisma/client";
import type { OrderVariableSource } from "./variables";

export const SMS_ORDER_INCLUDE = { site: true } as const;
export type OrderWithSite = Prisma.OrderGetPayload<{ include: typeof SMS_ORDER_INCLUDE }>;

export function orderToVariableSource(order: OrderWithSite): OrderVariableSource {
  return {
    orderNumber: order.orderNumber,
    senderName: order.senderName,
    recipientName: order.recipientName,
    senderPhone: order.senderPhone,
    recipientPhone: order.recipientPhone,
    addressLine: order.addressLine,
    apartment: order.apartment,
    city: order.city,
    deliveryDate: order.deliveryDate,
    deliveryWindow: order.deliveryWindow,
    trackingUrl: order.trackingUrl,
    cardMessage: order.cardMessage,
    deliveryInstructions: order.deliveryInstructions,
    customerTotal: order.customerTotal != null ? Number(order.customerTotal) : null,
    storeName: order.site.name,
    storePhone: order.site.quoPhoneNumber,
    reviewUrl: order.site.reviewUrl,
    timezone: order.site.timezone,
  };
}
