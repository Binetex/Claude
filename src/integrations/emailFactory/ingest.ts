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

/** Сколько писем берём за проход. Больше — только следующим проходом, курсор это учитывает. */
const PAGE_LIMIT = 100;

/** С какой глубины начинаем, когда писем ещё нет вовсе. Не тянем всю историю ящика. */
const FIRST_RUN_LOOKBACK_MS = 3 * 24 * 3600_000;

export type IngestResult = { fetched: number; stored: number; matched: number; skipped: string | null };

/**
 * Заказ, к которому относится письмо: самый свежий заказ ЭТОГО клиента (решение владельца) —
 * но ТОЛЬКО среди заказов магазина, на адрес которого письмо пришло.
 *
 * Одного отправителя мало: в аккаунте несколько доменов, и один и тот же клиент заказывает в
 * разных магазинах. Письмо на client@theflow.la про заказ TheFlow село бы в свежий заказ Plombir,
 * а ответ ушёл бы клиенту от чужого магазина. Наш адрес получателя — единственное, что говорит,
 * кому клиент вообще писал.
 *
 * Магазин определяется по домену нашего адреса, а не по полному совпадению: у магазина может быть
 * несколько ящиков на своём домене (order@, hello@), и все они его.
 */
async function findOrderFor(prisma: PrismaClient, fromEmail: string, toEmail: string): Promise<string | null> {
  const domain = toEmail.split("@")[1]?.toLowerCase();
  if (!domain) return null;

  const sites = await prisma.site.findMany({
    where: { emailFactoryDomain: { equals: domain, mode: "insensitive" } },
    select: { id: true },
  });
  // Домен не закреплён ни за одним магазином — привязывать не к чему. Письмо всё равно сохранится
  // непривязанным: оно нужно как курсор опроса.
  if (sites.length === 0) return null;

  const order = await prisma.order.findFirst({
    where: {
      senderEmail: { equals: fromEmail, mode: "insensitive" },
      siteId: { in: sites.map((s) => s.id) },
    },
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

  const since = await resolveSince(prisma);
  const res = await listInbound(token, since, PAGE_LIMIT);
  if (!res.ok) return { ...empty, skipped: res.code };

  // Пришло ровно столько, сколько влезло в страницу — значит за окно попало и что-то ещё, а
  // порядок выдачи провайдер не обещает. Сохраняем полученное (дубли отсечёт providerMessageId),
  // но НЕ даём курсору уехать: иначе непопавшие письма не запросятся уже никогда. Курсор — это
  // время сохранённого письма, поэтому просто не сохраняем самое свежее из страницы: следующий
  // проход начнётся раньше него и добёрёт хвост.
  const full = res.data.length >= PAGE_LIMIT;
  const batch = full
    ? [...res.data].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime()).slice(0, -1)
    : res.data;

  let stored = 0;
  let matched = 0;

  for (const m of batch) {
    // Письмо, которое мы уже видели, не трогаем повторно: заказ у него мог быть привязан вручную
    // или изменён, и перезапись затёрла бы это без причины.
    const exists = await prisma.orderEmailMessage.findUnique({ where: { providerMessageId: m.id }, select: { id: true } });
    if (exists) continue;

    const orderId = await findOrderFor(prisma, m.fromEmail, m.toEmail);
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

  return { fetched: res.data.length, stored, matched, skipped: full ? "page_full" : null };
}
