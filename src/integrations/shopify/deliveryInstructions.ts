import "server-only";
/**
 * Получение инструкций доставки native Shopify Local Delivery (Additional details →
 * Delivery instructions). Источник ПОДТВЕРЖДЁН на проде (заказ #41308):
 *   Order.fulfillmentOrders → node.deliveryMethod.additionalInformation.instructions
 * Их НЕТ в REST-payload / note_attributes, поэтому нужен отдельный GraphQL-запрос.
 *
 * ВАЖНО: поле fulfillmentOrders требует scope read_merchant_managed_fulfillment_orders
 * (+ read_assigned_fulfillment_orders). Пока scope не выдан магазином — Shopify вернёт
 * ACCESS_DENIED; функция best-effort: возвращает "" и не роняет приём заказа.
 */
import { resolveShopifyCredentials } from "./customApp/credentials";
import { pickDeliveryInstructionsFromFulfillmentOrders } from "./orderFields";

const API_VERSION = "2026-07";

const QUERY = `query($id: ID!) {
  order(id: $id) {
    fulfillmentOrders(first: 5) {
      edges { node { deliveryMethod { additionalInformation { instructions } } } }
    }
  }
}`;

type Resp = {
  data?: { order?: { fulfillmentOrders?: { edges: { node: { deliveryMethod?: { additionalInformation?: { instructions?: string | null } | null } | null } }[] } } | null };
  errors?: { message?: string }[];
};

/**
 * Возвращает первую непустую строку инструкций доставки для заказа (по externalId = Shopify order id),
 * либо "" (нет инструкций / нет scope / ошибка). Никогда не бросает.
 */
export async function fetchShopifyDeliveryInstructions(siteId: string, externalId: string): Promise<string> {
  try {
    const cred = await resolveShopifyCredentials(siteId);
    const res = await fetch(`https://${cred.shopDomain}/admin/api/${API_VERSION}/graphql.json`, {
      method: "POST",
      headers: { "X-Shopify-Access-Token": cred.accessToken, "Content-Type": "application/json" },
      body: JSON.stringify({ query: QUERY, variables: { id: `gid://shopify/Order/${externalId}` } }),
    });
    if (!res.ok) return "";
    const json = (await res.json()) as Resp;
    if (json.errors?.length) {
      // Чаще всего — ACCESS_DENIED (нет fulfillment-scope). Логируем ОДИН раз без PII.
      console.warn(`[shopify] delivery instructions недоступны для заказа ${externalId}: ${json.errors[0]?.message ?? "graphql error"}`);
      return "";
    }
    return pickDeliveryInstructionsFromFulfillmentOrders(json.data?.order?.fulfillmentOrders?.edges);
  } catch (err) {
    console.warn(`[shopify] delivery instructions fetch failed для ${externalId}:`, err instanceof Error ? err.message : String(err));
    return "";
  }
}
