import { NextResponse } from "next/server";
import { verifyWebhookHmac } from "@/integrations/shopify/webhookAuth";
import { ingestShopifyOrder } from "@/integrations/shopify/ingestOrder";
import { intakeShopifyCustomAppWebhook } from "@/integrations/shopify/customApp/webhookIntake";
import { featureFlags } from "@/lib/featureFlags";

/**
 * Приём вебхуков от Woo/Shopify.
 *
 * Shopify Custom App (основной путь): per-Site проверка подписи (secret приложения этого
 * магазина), дедуп по X-Shopify-Webhook-Id, быстрая публикация в persistent outbox, 200.
 * Legacy global-OAuth (fallback): старый путь с глобальным secret и inline-ingest.
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
    // 1) Основной путь — Custom App (per-Site secret). handled=false → магазин не custom-app.
    const headers = Object.fromEntries(request.headers.entries());
    const intake = await intakeShopifyCustomAppWebhook({ rawBody, headers });
    if (intake.handled) {
      return NextResponse.json(intake.body, { status: intake.status });
    }

    // 2) Fallback — legacy global-OAuth приложение.
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
