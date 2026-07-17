import { NextResponse } from "next/server";
import { verifyWebhookHmac } from "@/integrations/shopify/webhookAuth";
import { ingestShopifyOrder } from "@/integrations/shopify/ingestOrder";
import { featureFlags } from "@/lib/featureFlags";

/**
 * Приём вебхуков от Woo/Shopify.
 *
 * Для Shopify: проверяем подпись (X-Shopify-Hmac-Sha256) по СЫРОМУ телу до парсинга,
 * затем идемпотентно создаём/обновляем заказ (см. ingestShopifyOrder) и отвечаем быстро —
 * никаких SMS/email/Telegram здесь не отправляется (это в фоне, см. src/lib/jobs.ts).
 *
 * WooCommerce — каркас, реальный парсинг ещё не подключён.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ platform: string }> }
) {
  const { platform } = await params;
  if (!["woocommerce", "shopify"].includes(platform)) {
    return NextResponse.json({ error: "Unknown platform" }, { status: 404 });
  }

  const rawBody = await request.text();

  if (platform === "shopify") {
    if (!featureFlags.shopify) {
      return NextResponse.json({ error: "Shopify integration disabled" }, { status: 503 });
    }

    const hmac = request.headers.get("x-shopify-hmac-sha256");
    if (!verifyWebhookHmac(rawBody, hmac)) {
      return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    }

    const shopDomain = request.headers.get("x-shopify-shop-domain");
    const topic = request.headers.get("x-shopify-topic");
    if (!shopDomain || !topic) {
      return NextResponse.json({ error: "Missing Shopify headers" }, { status: 400 });
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await ingestShopifyOrder(topic, shopDomain, payload as any);
    } catch (err) {
      console.error(`[shopify] ошибка обработки вебхука ${topic}:`, err);
      // Отвечаем 200, чтобы Shopify не долбил повторами бесконечно на баг в маппинге —
      // ошибка уже залогирована, разбор — вручную по логам.
    }

    return NextResponse.json({ received: true });
  }

  // WooCommerce — каркас этапа 1, реальные заказы пока не создаёт.
  return NextResponse.json({ received: true });
}
