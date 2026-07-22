import "server-only";
/**
 * Программная регистрация WooCommerce webhooks для Site без дублей: получаем существующие,
 * создаём только недостающие (по topic + наш delivery_url), сохраняем внешние ID/статус в
 * WooCommerceWebhook. Секрет подписи — уникальный per-Site (не Consumer Secret). Delivery URL — HTTPS.
 *
 * Топики (проверены по WooCommerce REST v3 webhooks): order.created/updated/deleted,
 * product.created/updated/deleted.
 */
import { prisma } from "@/lib/db";
import { getAppUrl } from "@/lib/appUrl";
import { resolveWooCredentials, resolveWooWebhookSecret } from "./credentials";
import { wooGet, wooRequest, type WooClientOptions } from "./client";

export const REQUIRED_WOO_TOPICS = [
  "order.created",
  "order.updated",
  "order.deleted",
  "product.created",
  "product.updated",
  "product.deleted",
] as const;
export type WooTopic = (typeof REQUIRED_WOO_TOPICS)[number];

type WooWebhookApi = { id: number | string; topic: string; delivery_url: string; status?: string };

function deliveryUrl(siteId: string): string {
  return `${getAppUrl()}/api/webhooks/woocommerce/${siteId}`;
}

export async function registerWooWebhooks(
  siteId: string,
  opts: WooClientOptions = {}
): Promise<{ created: WooTopic[]; existing: WooTopic[]; failed: { topic: WooTopic; error: string }[] }> {
  const creds = await resolveWooCredentials(siteId);
  const secret = await resolveWooWebhookSecret(siteId);
  if (!secret) throw new Error("Нет webhook secret для Site — переподключите магазин.");
  const cb = deliveryUrl(siteId);
  if (!cb.startsWith("https://")) throw new Error("Delivery URL должен быть HTTPS.");

  // Существующие подписки с нашим delivery_url.
  const { data: existingList } = await wooGet<WooWebhookApi[]>(creds, "/webhooks", { per_page: 100 }, opts);
  const already = new Map<string, string>();
  for (const w of existingList ?? []) {
    if (w.delivery_url === cb) already.set(w.topic, String(w.id));
  }

  const created: WooTopic[] = [];
  const existing: WooTopic[] = [];
  const failed: { topic: WooTopic; error: string }[] = [];

  for (const topic of REQUIRED_WOO_TOPICS) {
    try {
      let externalId = already.get(topic) ?? null;
      if (externalId) {
        existing.push(topic);
      } else {
        const { data } = await wooRequest<WooWebhookApi>(
          creds,
          "/webhooks",
          { method: "POST", body: { name: `Floremart ${topic}`, topic, delivery_url: cb, secret, status: "active" } },
          opts
        );
        externalId = data?.id != null ? String(data.id) : null;
        created.push(topic);
      }
      await prisma.wooCommerceWebhook.upsert({
        where: { siteId_topic: { siteId, topic } },
        create: { siteId, topic, externalId, deliveryUrl: cb, status: "ACTIVE" },
        update: { externalId, deliveryUrl: cb, status: "ACTIVE", lastError: null },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message.slice(0, 300) : "unknown";
      failed.push({ topic, error: msg });
      await prisma.wooCommerceWebhook.upsert({
        where: { siteId_topic: { siteId, topic } },
        create: { siteId, topic, deliveryUrl: cb, status: "FAILED", lastError: msg },
        update: { status: "FAILED", lastError: msg },
      });
    }
  }
  return { created, existing, failed };
}
