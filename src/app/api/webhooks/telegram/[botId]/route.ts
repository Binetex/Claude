import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { PrismaOutboxRepository } from "@/outbox/prismaRepository";
import { TELEGRAM_UPDATE_EVENT } from "@/modules/assistant/telegramReply";

/**
 * Приём обновлений Telegram: нажатия кнопок и ответы владельца реплаем.
 *
 * Как и у QUO, здесь только приём: разобрать и что-то отправить может занять секунды, а Telegram
 * ждёт быстрый ответ и повторяет доставку на любой не-200. Поэтому кладём обновление в очередь и
 * сразу отвечаем.
 *
 * Защита — секретный заголовок, который Telegram шлёт сам (он задаётся при регистрации вебхука).
 * URL со случайным botId недостаточно: он попадает в логи и историю браузера.
 */
export const runtime = "nodejs";

export async function POST(request: Request, ctx: { params: Promise<{ botId: string }> }) {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET?.trim();
  if (!secret) return NextResponse.json({ disabled: true }, { status: 200 });
  if (request.headers.get("x-telegram-bot-api-secret-token") !== secret) {
    // Не 401: чужому запросу незачем знать, угадал он адрес или нет.
    return NextResponse.json({ ok: true }, { status: 200 });
  }

  const { botId } = await ctx.params;
  const update = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!update) return NextResponse.json({ ok: true }, { status: 200 });

  const updateId = typeof update.update_id === "number" ? String(update.update_id) : null;
  const repo = new PrismaOutboxRepository(prisma);
  await repo
    .enqueue({
      eventType: TELEGRAM_UPDATE_EVENT,
      aggregateType: "telegram",
      aggregateId: botId,
      payload: { botId, update },
      // Telegram повторяет доставку при любом сбое — дедуп по номеру обновления.
      idempotencyKey: `telegram.update:${botId}:${updateId ?? crypto.randomUUID()}`,
    })
    .catch(() => null);

  return NextResponse.json({ ok: true }, { status: 200 });
}
