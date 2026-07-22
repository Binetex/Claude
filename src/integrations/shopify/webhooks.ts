import "server-only";
import { getAppUrl } from "@/lib/appUrl";

const API_VERSION = "2026-07";

// Темы, которые нам нужны для приёма заказов (см. src/integrations/shopify/ingestOrder.ts).
const REQUIRED_TOPICS = ["ORDERS_CREATE", "ORDERS_UPDATED", "ORDERS_PAID", "ORDERS_CANCELLED"] as const;

type WebhookSubscriptionsResponse = {
  data?: {
    webhookSubscriptions?: { edges: { node: { topic: string; endpoint: { callbackUrl?: string } } }[] };
  };
};

type WebhookCreateResponse = {
  data?: { webhookSubscriptionCreate?: { userErrors?: { field: string; message: string }[] } };
};

async function graphql<T>(shopDomain: string, accessToken: string, query: string, variables?: object): Promise<T> {
  const res = await fetch(`https://${shopDomain}/admin/api/${API_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "X-Shopify-Access-Token": accessToken, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`Shopify GraphQL ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

/**
 * Явно регистрирует подписки на вебхуки заказов после установки приложения на магазин.
 *
 * Декларация в shopify.app.toml ([[webhooks.subscriptions]]) НЕ подписала их
 * автоматически при установке (проверено вживую на O'hara Florist — после install
 * webhookSubscriptions был пуст) — поэтому регистрируем через Admin API явно и
 * идемпотентно (пропускаем темы, которые уже подписаны на наш callback URL).
 */
export async function registerOrderWebhooks(shopDomain: string, accessToken: string): Promise<void> {
  const callbackUrl = `${getAppUrl()}/api/webhooks/shopify`;

  const existing = await graphql<WebhookSubscriptionsResponse>(
    shopDomain,
    accessToken,
    `{ webhookSubscriptions(first: 50) { edges { node { topic endpoint { __typename ... on WebhookHttpEndpoint { callbackUrl } } } } } }`
  );
  const already = new Set(
    (existing.data?.webhookSubscriptions?.edges ?? [])
      .filter((e) => e.node.endpoint.callbackUrl === callbackUrl)
      .map((e) => e.node.topic)
  );

  const mutation = `
    mutation CreateWebhook($topic: WebhookSubscriptionTopic!, $webhookSubscription: WebhookSubscriptionInput!) {
      webhookSubscriptionCreate(topic: $topic, webhookSubscription: $webhookSubscription) {
        webhookSubscription { id }
        userErrors { field message }
      }
    }
  `;

  for (const topic of REQUIRED_TOPICS) {
    if (already.has(topic)) continue;
    const result = await graphql<WebhookCreateResponse>(shopDomain, accessToken, mutation, {
      topic,
      webhookSubscription: { callbackUrl, format: "JSON" },
    });
    const errors = result.data?.webhookSubscriptionCreate?.userErrors;
    if (errors && errors.length > 0) {
      console.error(`[shopify] не удалось подписать вебхук ${topic} для ${shopDomain}:`, errors);
    }
  }
}
