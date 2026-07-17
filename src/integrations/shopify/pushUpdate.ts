import "server-only";
import { prisma } from "@/lib/db";

const API_VERSION = "2026-07";

/**
 * Пишет адрес получателя и текст открытки обратно в Shopify.
 *
 * У этого магазина открытка (cardMessage) хранится в стандартном поле заказа Shopify
 * "note" — то же самое поле, которое мы читаем при приёме заказа (см.
 * extractAddressAndCardMessage в ingestOrder.ts), поэтому оно действительно двустороннее.
 * customerNote и дата/интервал доставки НЕ синхронизируются: customerNote — ручное поле
 * владельца/колл-центра, Shopify им не управляет; дата/интервал парсятся из
 * note_attributes, а это поле нельзя изменить через Admin API после создания заказа.
 * shipping_address тоже может быть отклонён Shopify, если заказ уже fulfilled/locked —
 * в этом случае молча логируем и продолжаем (не бросаем исключение, не показываем
 * ошибку владельцу).
 */
export async function pushOrderUpdate(
  shopDomain: string,
  accessToken: string,
  externalId: string,
  fields: {
    recipientName: string;
    recipientPhone: string;
    addressLine: string;
    apartment: string | null;
    city: string;
    zip: string;
    cardMessage: string;
  }
): Promise<void> {
  try {
    const res = await fetch(`https://${shopDomain}/admin/api/${API_VERSION}/orders/${externalId}.json`, {
      method: "PUT",
      headers: { "X-Shopify-Access-Token": accessToken, "Content-Type": "application/json" },
      body: JSON.stringify({
        order: {
          id: externalId,
          note: fields.cardMessage,
          shipping_address: {
            name: fields.recipientName,
            phone: fields.recipientPhone,
            address1: fields.addressLine,
            address2: fields.apartment ?? "",
            city: fields.city,
            zip: fields.zip,
          },
        },
      }),
    });
    if (!res.ok) {
      console.warn(
        `[shopify] не удалось обновить заказ ${externalId} в Shopify: ${res.status}` +
          (res.status === 422 ? " (вероятно, заказ уже fulfilled — адрес нельзя менять)" : "")
      );
    }
  } catch (err) {
    console.warn(`[shopify] ошибка обновления заказа ${externalId} в Shopify:`, err instanceof Error ? err.message : err);
  }
}

/**
 * Читает актуальное состояние заказа из нашей БД и пушит адрес+открытку в Shopify,
 * если заказ пришёл оттуда и магазин подключён. Не бросает исключений — вызывающий
 * server action не должен падать из-за недоступности Shopify.
 */
export async function syncOrderToShopify(orderId: string): Promise<void> {
  const order = await prisma.order.findUnique({ where: { id: orderId }, include: { site: true } });
  if (!order || order.platform !== "SHOPIFY" || !order.externalId) return;
  const { site } = order;
  if (!site.shopifyShopDomain || !site.shopifyAccessToken) return;

  await pushOrderUpdate(site.shopifyShopDomain, site.shopifyAccessToken, order.externalId, {
    recipientName: order.recipientName,
    recipientPhone: order.recipientPhone,
    addressLine: order.addressLine,
    apartment: order.apartment,
    city: order.city,
    zip: order.zip,
    cardMessage: order.cardMessage,
  });
}
