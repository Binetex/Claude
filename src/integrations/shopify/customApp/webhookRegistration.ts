import "server-only";
/**
 * Регистрация Shopify webhook-подписок для Site без дублей: проверяем существующие
 * (по topic + callbackUrl), создаём только недостающие, сохраняем внешние ID и статус в
 * ShopifyWebhook. Callback — единый эндпоинт Floremart. Реальные вызовы идут через
 * единый клиент (credentials из Site). Не запускать против production-магазина без подтверждения.
 */
import { prisma } from "@/lib/db";
import { shopifyAdminGraphQL } from "./client";
import { getAppUrl } from "@/lib/appUrl";

/** Топики, которые нужны Floremart (минимум). */
export const REQUIRED_WEBHOOK_TOPICS = ["ORDERS_CREATE", "ORDERS_UPDATED", "ORDERS_CANCELLED"] as const;
export type WebhookTopic = (typeof REQUIRED_WEBHOOK_TOPICS)[number];

function callbackUrl(): string {
  return `${getAppUrl()}/api/webhooks/shopify`;
}

type ExistingData = {
  webhookSubscriptions: {
    edges: { node: { id: string; topic: string; endpoint: { __typename: string; callbackUrl?: string } } }[];
  };
};

const EXISTING_QUERY = `{
  webhookSubscriptions(first: 100) {
    edges { node { id topic endpoint { __typename ... on WebhookHttpEndpoint { callbackUrl } } } }
  }
}`;

const CREATE_MUTATION = `mutation CreateWebhook($topic: WebhookSubscriptionTopic!, $callbackUrl: URL!) {
  webhookSubscriptionCreate(topic: $topic, webhookSubscription: { callbackUrl: $callbackUrl, format: JSON }) {
    userErrors { field message }
    webhookSubscription { id }
  }
}`;

type CreateData = {
  webhookSubscriptionCreate: { userErrors: { message: string }[]; webhookSubscription: { id: string } | null };
};

/**
 * Синхронизирует нужные подписки: создаёт отсутствующие, не дублирует существующие
 * (с нашим callbackUrl). Сохраняет ShopifyWebhook (siteId+topic уникален). Возвращает сводку.
 */
export async function registerWebhooks(siteId: string): Promise<{ created: WebhookTopic[]; existing: WebhookTopic[]; failed: { topic: WebhookTopic; error: string }[] }> {
  const cb = callbackUrl();
  const existingData = await shopifyAdminGraphQL<ExistingData>(siteId, EXISTING_QUERY);
  const already = new Map<string, string>(); // topic -> shopify webhook id (с нашим callback)
  for (const e of existingData.webhookSubscriptions.edges) {
    if (e.node.endpoint.callbackUrl === cb) already.set(e.node.topic, e.node.id);
  }

  const created: WebhookTopic[] = [];
  const existing: WebhookTopic[] = [];
  const failed: { topic: WebhookTopic; error: string }[] = [];

  for (const topic of REQUIRED_WEBHOOK_TOPICS) {
    try {
      let shopifyWebhookId = already.get(topic) ?? null;
      if (shopifyWebhookId) {
        existing.push(topic);
      } else {
        const res = await shopifyAdminGraphQL<CreateData>(siteId, CREATE_MUTATION, { topic, callbackUrl: cb });
        const errs = res.webhookSubscriptionCreate.userErrors;
        if (errs.length > 0) throw new Error(errs.map((u) => u.message).join("; "));
        shopifyWebhookId = res.webhookSubscriptionCreate.webhookSubscription?.id ?? null;
        created.push(topic);
      }
      await prisma.shopifyWebhook.upsert({
        where: { siteId_topic: { siteId, topic } },
        create: { siteId, topic, shopifyWebhookId, status: "ACTIVE" },
        update: { shopifyWebhookId, status: "ACTIVE", lastError: null },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message.slice(0, 300) : "unknown";
      failed.push({ topic, error: msg });
      await prisma.shopifyWebhook.upsert({
        where: { siteId_topic: { siteId, topic } },
        create: { siteId, topic, status: "FAILED", lastError: msg },
        update: { status: "FAILED", lastError: msg },
      });
    }
  }
  return { created, existing, failed };
}
