import { bouquetPageUrl } from "@/lib/bouquetPage";
import "server-only";
/** Общий маппер Prisma-заказа (+Site) в срез переменных шаблона. Используют движки правил
 *  и цепочек, preview и reviews/sendLink.
 *  Импорт locationPick — единственная разрешённая ссылка messaging → reviews (boundary.test.ts). */
import type { Prisma } from "@/generated/prisma/client";
import { resolveSupportEmail, type OrderVariableSource } from "./variables";
import { pickLocation, pickedReviewUrl } from "@/modules/reviews/locationPick";

// emailSettings нужны ради {{support_email}} (reply-to магазина, иначе адрес отправителя).
// googleLocations — ради {{review_url}}: ссылка на отзыв больше не одна на магазин, её решает
// адрес доставки (ближайшая точка). Включаем здесь, а не в каждом вызове: источник переменных
// должен быть один на всех потребителей — движок правил, движок цепочек, preview и
// отправка ссылок на отзыв.
export const SMS_ORDER_INCLUDE = {
  site: { include: { emailSettings: true, googleLocations: true } },
} as const;
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
    // Ссылка на отзыв — ТА ЖЕ, что показывает раздел «Отзывы»: ближайшая к адресу точка, а
    // если её нет — общая ссылка магазина. Второго способа получить {{review_url}} быть не
    // должно: рассылка и карточка запроса обязаны вести клиента в одно и то же место.
    reviewUrl: pickedReviewUrl(pickLocation(order.zip, order.site.googleLocations, order.site.reviewUrl)),
    // Клиенту уходит страница, а не сырой файл: картинку в SMS не вложить, а ссылка на
    // страницу открывается с подписью магазина и нормальным превью.
    bouquetPhotoUrl: bouquetPageUrl(order.bouquetPhotoUrl),
    timezone: order.site.timezone,
    supportEmail: resolveSupportEmail(order.site.emailSettings),
  };
}
