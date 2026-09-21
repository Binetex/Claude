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
import { listInbound, type EmailFactoryMessage } from "./client";
import { publishTelegramNotification } from "@/integrations/telegram/events";

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
/**
 * Номер заказа из темы письма: «Re: Заказ JF-1001380» → «JF-1001380».
 *
 * Тему первого письма пишем мы сами (`Заказ <номер>`), клиент отвечает с «Re:» и номер несёт
 * обратно. Это единственный признак, который переживает всё остальное: ответ с другого адреса,
 * пересланное письмо, новый тред у провайдера.
 */
export function orderNumberInSubject(subject: string | null): string | null {
  const m = /\b([A-Z]{2,12}-\d{3,12})\b/.exec((subject ?? "").toUpperCase());
  return m?.[1] ?? null;
}

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

/**
 * Заказ для входящего письма. Три признака по убыванию надёжности, первый сработавший выигрывает.
 *
 * 1. НОМЕР ЗАКАЗА В ТЕМЕ. Владелец пишет клиенту из карточки, тема получается «Заказ JF-1001380»,
 *    и ответ приходит с «Re:» и тем же номером. Это ровно тот разговор, который он начал, —
 *    сильнее любой догадки по адресу.
 * 2. ТРЕД ПРОВАЙДЕРА, если в нём уже есть наше письмо с заказом. Работает, когда тему обрезали
 *    или переписали, но переписка продолжается в той же цепочке. Провайдер, впрочем, заводит
 *    ответу СВОЙ тред не всегда тот же (проверено 21.09.2026), поэтому признак второй, а не первый.
 * 3. Адрес отправителя плюс наш домен → самый свежий заказ этого клиента. Прежнее поведение;
 *    оно и остаётся для писем, начатых клиентом, а не нами.
 */
async function resolveOrderId(prisma: PrismaClient, m: EmailFactoryMessage): Promise<string | null> {
  const number = orderNumberInSubject(m.subject);
  if (number) {
    const byNumber = await prisma.order.findFirst({
      where: { orderNumber: { equals: number, mode: "insensitive" } },
      select: { id: true },
    });
    if (byNumber) return byNumber.id;
  }

  if (m.threadId) {
    const inThread = await prisma.orderEmailMessage.findFirst({
      where: { threadId: m.threadId, orderId: { not: null } },
      orderBy: { occurredAt: "desc" },
      select: { orderId: true },
    });
    if (inThread?.orderId) return inThread.orderId;
  }

  return findOrderFor(prisma, m.fromEmail, m.toEmail);
}

/**
 * Сколько текста письма уходит в Telegram.
 *
 * Цитату прошлой переписки режем: почтовые клиенты подклеивают к ответу всё письмо целиком, и
 * в уведомлении оно занимало бы экран, пряча те две строки, ради которых клиент и писал.
 */
const QUOTE_START = /^\s*(?:>|On .+ wrote:|-{2,}\s*Original Message|_{5,}|From:\s)/m;

export function emailQuoteForTelegram(text: string, limit = 500): string {
  const cut = text.search(QUOTE_START);
  const body = (cut > 0 ? text.slice(0, cut) : text).trim();
  return body.length > limit ? `${body.slice(0, limit).trimEnd()}…` : body;
}

/** Письма старше этого в Telegram не уводомляют: разбор старого ящика не должен звонить в ночь. */
const NOTIFY_MAX_AGE_MS = 6 * 3600_000;

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

    const orderId = await resolveOrderId(prisma, m);
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
    if (!orderId) continue;
    matched += 1;

    // Ответ клиента по почте — владельцу в Telegram. Почту никто не держит открытой, и без
    // этого сообщения ответ лежал бы до следующего захода в карточку: 21.09.2026 так пролежал
    // код ворот, присланный за сутки до доставки.
    //
    // Только свежие: если курсор опроса когда-нибудь отъедет назад, разбор старого ящика не
    // должен высыпать пачку уведомлений о давно разобранных письмах.
    if (Date.now() - m.occurredAt.getTime() > NOTIFY_MAX_AGE_MS) continue;
    await publishTelegramNotification(prisma, {
      type: "customer.email_reply",
      orderId,
      occurrenceKey: m.id,
      context: { from: m.fromEmail, subject: m.subject ?? "", quote: emailQuoteForTelegram(m.text) },
    });
  }

  return { fetched: res.data.length, stored, matched, skipped: full ? "page_full" : null };
}
