import { NextResponse } from "next/server";
import { intakeBurqWebhook } from "@/integrations/delivery/burq/webhookIntake";

/**
 * Приём Burq webhook о статусе доставки. Подпись (Burq-Signature, HMAC-SHA256) проверяется
 * до парсинга тела; событие ставится в outbox и обрабатывается worker'ом (anti-rollback,
 * дедуп, publish completed на DELIVERED). Общий endpoint (Burq идентифицирует заказ по своему id).
 */
export async function POST(request: Request) {
  const rawBody = await request.text();
  const headers = Object.fromEntries(request.headers.entries());
  try {
    const result = await intakeBurqWebhook({ rawBody, headers });
    return NextResponse.json(result.body, { status: result.status });
  } catch (err) {
    console.error("[burq] ошибка приёма вебхука:", err instanceof Error ? err.message : err);
    // 200, чтобы Burq не отключил подписку из-за временного сбоя — событие (если верифицировано
    // и поставлено в outbox) обработается worker'ом; иначе Burq повторит доставку вебхука.
    return NextResponse.json({ received: true }, { status: 200 });
  }
}
