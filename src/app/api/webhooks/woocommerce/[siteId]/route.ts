import { NextResponse } from "next/server";
import { intakeWooWebhook } from "@/integrations/woocommerce/webhookIntake";

/**
 * Приём WooCommerce webhook для конкретного Site. Подпись проверяется per-Site (secret этого
 * магазина); тело парсится только после проверки; дедуп и async-обработка — через outbox/worker.
 * Endpoint per-Site (а не общий), т.к. WooCommerce не шлёт домен магазина отдельным заголовком —
 * идентификация магазина по siteId в URL + HMAC его секретом.
 */
export async function POST(request: Request, { params }: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await params;
  const rawBody = await request.text();
  const headers = Object.fromEntries(request.headers.entries());

  try {
    const result = await intakeWooWebhook({ siteId, rawBody, headers });
    return NextResponse.json(result.body, { status: result.status });
  } catch (err) {
    console.error("[woo] ошибка приёма вебхука:", err instanceof Error ? err.message : err);
    // 200, чтобы WooCommerce не отключил подписку из-за временного сбоя нашей стороны —
    // ошибка залогирована, событие (если дошло до outbox) обработается worker'ом.
    return NextResponse.json({ received: true }, { status: 200 });
  }
}
