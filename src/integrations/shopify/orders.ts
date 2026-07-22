import "server-only";
import type { ShopifyOrder } from "./ingestOrder";

const API_VERSION = "2026-07";
const PAGE_SIZE = 250;
const BUCKET_SIZE = 40;
const SAFETY_MARGIN = 5;

function parseNextLink(header: string | null): string | undefined {
  if (!header) return undefined;
  const next = header.split(",").find((p) => p.includes('rel="next"'));
  const m = next?.match(/<([^>]+)>/);
  return m?.[1];
}

async function throttle(res: Response): Promise<void> {
  const header = res.headers.get("X-Shopify-Shop-Api-Call-Limit");
  if (!header) return;
  const [used] = header.split("/").map(Number);
  if (Number.isFinite(used) && used >= BUCKET_SIZE - SAFETY_MARGIN) {
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/** Общее число заказов начиная с sinceIso (для прогресса «X из Y»). null — если недоступно. */
export async function countOrdersSince(
  shopDomain: string,
  accessToken: string,
  sinceIso: string
): Promise<number | null> {
  const res = await fetch(
    `https://${shopDomain}/admin/api/${API_VERSION}/orders/count.json?status=any&created_at_min=${encodeURIComponent(sinceIso)}`,
    { headers: { "X-Shopify-Access-Token": accessToken } }
  );
  if (!res.ok) return null;
  const data = (await res.json()) as { count?: number };
  return typeof data.count === "number" ? data.count : null;
}

/** Постранично отдаёт заказы Shopify начиная с sinceIso (курсорная пагинация). */
export async function* fetchOrdersSince(
  shopDomain: string,
  accessToken: string,
  sinceIso: string
): AsyncGenerator<ShopifyOrder, void, unknown> {
  let url: string | undefined =
    `https://${shopDomain}/admin/api/${API_VERSION}/orders.json?status=any&created_at_min=${encodeURIComponent(sinceIso)}&limit=${PAGE_SIZE}`;

  while (url) {
    const res: Response = await fetch(url, { headers: { "X-Shopify-Access-Token": accessToken } });
    if (!res.ok) throw new Error(`Shopify orders.json: ${res.status} ${await res.text()}`);
    await throttle(res);
    const body = (await res.json()) as { orders?: ShopifyOrder[] };
    for (const order of body.orders ?? []) yield order;
    url = parseNextLink(res.headers.get("link") ?? res.headers.get("Link"));
  }
}
