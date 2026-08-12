import "server-only";
/**
 * Приём входящих писем: опрос Email Factory → привязка к заказу → строка в OrderEmailMessage.
 *
 * ПОЧЕМУ ОПРОС, А НЕ ВЕБХУК (решение владельца 2026-08-12). У провайдера нет фильтра по адресу
 * получателя, поэтому вебхук всё равно требовал бы доработки на его стороне, а `since` работает и
 * реально фильтрует. Опрос делается целиком у нас, механизм интервальных задач в воркере уже
 * обкатан на Burq. Один запрос в пять минут — это не нагрузка.
 *
 * КУРСОР НЕ ХРАНИТСЯ ОТДЕЛЬНО. Точка отсчёта — время самого свежего сохранённого входящего письма
 * минус нахлёст. Отдельная строка с курсором разъезжалась бы с фактически сохранёнными письмами
 * при любой частичной неудаче; здесь состояние ровно одно и оно же — данные. Ради этого мы храним
 * и НЕПРИВЯЗАННЫЕ письма: без них курсор застревал бы на последнем привязанном, и одни и те же
 * письма выгружались бы снова и снова. Показываются они всё равно только в своём заказе.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { resolveEmailFactoryToken } from "./token";
import { listInbound } from "./client";

/** Нахлёст: пере-спрашиваем чуть раньше курсора. Дубли отсекает уникальный providerMessageId. */
const OVERLAP_MS = 2 * 60_000;

/** С какой глубины начинаем, когда писем ещё нет вовсе. Не тянем всю историю ящика. */
const FIRST_RUN_LOOKBACK_MS = 3 * 24 * 3600_000;

export type IngestResult = { fetched: number; stored: number; matched: number; skipped: string | null };

/**
 * Заказ, к которому относится письмо: самый свежий заказ ЭТОГО клиента (решение владельца).
 * Сравнение адресов без учёта регистра — «Ivan@Mail.ru» и «ivan@mail.ru» это один человек.
 */
async function findOrderByEmail(prisma: PrismaClient, fromEmail: string): Promise<string | null> {
  const order = await prisma.order.findFirst({
    where: { senderEmail: { equals: fromEmail, mode: "insensitive" } },
    orderBy: [{ externalCreatedAt: "desc" }, { createdAt: "desc" }],
    select: { id: true },
  });
  return order?.id ?? null;
}

async function resolveSince(prisma: PrismaClient): Promise<Date> {
  const latest = await prisma.orderEmailMessage.findFirst({
    where: { direction: "INBOUND" },
    orderBy: { occurredAt: "desc" },
    select: { occurredAt: true },
  });
  if (!latest) return new Date(Date.now() - FIRST_RUN_LOOKBACK_MS);
  return new Date(latest.occurredAt.getTime() - OVERLAP_MS);
}

export async function ingestInboundEmails(prisma: PrismaClient): Promise<IngestResult> {
  const empty: IngestResult = { fetched: 0, stored: 0, matched: 0, skipped: null };

  const token = await resolveEmailFactoryToken(prisma);
  if (!token) return { ...empty, skipped: "no_token" };

  const res = await listInbound(token, await resolveSince(prisma));
  if (!res.ok) return { ...empty, skipped: res.code };

  let stored = 0;
  let matched = 0;

  for (const m of res.data) {
    // Письмо, которое мы уже видели, не трогаем повторно: заказ у него мог быть привязан вручную
    // или изменён, и перезапись затёрла бы это без причины.
    const exists = await prisma.orderEmailMessage.findUnique({ where: { providerMessageId: m.id }, select: { id: true } });
    if (exists) continue;

    const orderId = await findOrderByEmail(prisma, m.fromEmail);
    await prisma.orderEmailMessage.create({
      data: {
        orderId,
        providerMessageId: m.id,
        threadId: m.threadId,
        direction: "INBOUND",
        status: "RECEIVED",
        fromEmail: m.fromEmail,
        toEmail: m.toEmail,
        subject: m.subject,
        text: m.text,
        occurredAt: m.occurredAt,
      },
    });
    stored += 1;
    if (orderId) matched += 1;
  }

  return { fetched: res.data.length, stored, matched, skipped: null };
}
