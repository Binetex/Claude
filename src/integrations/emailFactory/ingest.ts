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
import { PrismaOutboxRepository } from "@/outbox/prismaRepository";
import { publishAssistantEmail } from "@/modules/assistant/events";

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
 * Тему первого письма пишем мы сами (`Order <номер>`, раньше `Заказ <номер>`), клиент отвечает с «Re:» и номер несёт
 * обратно. Это единственный признак, который переживает всё остальное: ответ с другого адреса,
 * пересланное письмо, новый тред у провайдера.
 */
export function orderNumberInSubject(subject: string | null): string | null {
  const m = /\b([A-Z]{2,12}-\d{3,12})\b/.exec((subject ?? "").toUpperCase());
  return m?.[1] ?? null;
}

async function findOrderFor(prisma: PrismaClient, fromEmail: string, toEmail: string): Promise<string | null> {
  const siteIds = await siteIdsForAddress(prisma, toEmail);
  // Домен не закреплён ни за одним магазином — привязывать не к чему. Письмо всё равно сохранится
  // непривязанным: оно нужно как курсор опроса.
  if (siteIds.length === 0) return null;

  const order = await prisma.order.findFirst({
    where: {
      senderEmail: { equals: fromEmail, mode: "insensitive" },
      siteId: { in: siteIds },
    },
    orderBy: [{ externalCreatedAt: "desc" }, { createdAt: "desc" }],
    select: { id: true },
  });
  return order?.id ?? null;
}

/** Магазины, за которыми закреплён домен нашего адреса. Пусто — адрес не магазинный. */
async function siteIdsForAddress(prisma: PrismaClient, address: string): Promise<string[]> {
  const domain = address.split("@")[1]?.toLowerCase();
  if (!domain) return [];
  const sites = await prisma.site.findMany({
    where: { emailFactoryDomain: { equals: domain, mode: "insensitive" } },
    select: { id: true },
  });
  return sites.map((s) => s.id);
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
 *    сильнее любой догадки по адресу. Номер ищем только среди заказов магазина, на чей адрес
 *    пришло письмо: мы пишем про заказ с домена его магазина, и ответ приходит туда же. Чужой
 *    номер в теме увёл бы письмо в заказ другого магазина, и ассистент ответил бы от его имени.
 * 2. ТРЕД ПРОВАЙДЕРА, если в нём уже есть наше письмо с заказом. Работает, когда тему обрезали
 *    или переписали, но переписка продолжается в той же цепочке. Провайдер, впрочем, заводит
 *    ответу СВОЙ тред не всегда тот же (проверено 21.09.2026), поэтому признак второй, а не первый.
 * 3. Адрес отправителя плюс наш домен → самый свежий заказ этого клиента. Прежнее поведение;
 *    оно и остаётся для писем, начатых клиентом, а не нами.
 */
async function resolveOrderId(prisma: PrismaClient, m: EmailFactoryMessage): Promise<string | null> {
  const number = orderNumberInSubject(m.subject);
  if (number) {
    // Адрес не магазинный (домен ни за кем не закреплён) — ищем по номеру везде, как раньше.
    const siteIds = await siteIdsForAddress(prisma, m.toEmail);
    const byNumber = await prisma.order.findFirst({
      where: { orderNumber: { equals: number, mode: "insensitive" }, ...(siteIds.length ? { siteId: { in: siteIds } } : {}) },
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
 *
 * Шапку «On … wrote:» Gmail переносит на вторую строку, когда имя с адресом длинные (на проде
 * так у двух писем из девяти с шапкой). Хвост «On Mon, Sep 28, 2026 at 5:12 PM …» без переноса
 * оставался бы словами клиента — с чужими днём и временем внутри.
 */
const QUOTE_START = /^\s*(?:>|On .+ wrote:|On [^\n]+\n[^\n]*wrote:|-{2,}\s*Original Message|_{5,}|From:\s)/m;

/** Подписи почтовых приложений — не слова клиента: «Sent from my iPhone», «Get Outlook for iOS». */
const APP_SIGNATURE = /^\s*(?:sent from my .*|sent from (?:yahoo|mail|outlook|gmail)\b.*|get outlook for .*)\s*$/gim;

/**
 * Новое в письме клиента — то, на что отвечает ассистент: без цитаты прошлой переписки и без
 * подписи почтового приложения. Письмо из одной цитаты даёт пустую строку: нового в нём нет.
 */
export function emailNewText(text: string): string {
  const cut = text.search(QUOTE_START);
  const body = cut >= 0 ? text.slice(0, cut) : text;
  return body.replace(APP_SIGNATURE, "").trim();
}

/**
 * Письма почтовых роботов: автоответ «я в отпуске», отбойник о недоставке, адреса no-reply.
 * Отвечать им нельзя — автоответчик ответит снова, и переписка пойдёт по кругу до потолка ответов.
 * Заголовков вроде Auto-Submitted провайдер не отдаёт, поэтому узнаём по адресу, теме и тексту.
 */
const ROBOT_SENDER = /^(?:mailer-daemon|postmaster|no-?reply|do-?not-?reply)@/i;
const AUTO_SUBJECT = /^\s*(?:automatic reply|auto[- ]?reply|auto[- ]?response|out of (?:the )?office|undeliverable|undelivered mail|delivery status notification|mail delivery (?:failed|failure|subsystem)|returned mail)\b/i;
const AUTO_TEXT = /\b(?:i am|i'm|i’m) (?:currently )?(?:out of|away from) (?:the |my )?office\b|\bthis is an (?:automated|automatic) (?:reply|response|message)\b/i;

export function isAutoReply(m: { fromEmail: string; subject: string | null; text: string }): boolean {
  return ROBOT_SENDER.test(m.fromEmail.trim()) || AUTO_SUBJECT.test(m.subject ?? "") || AUTO_TEXT.test(emailNewText(m.text));
}

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
  //
  // Сохраняем от старых к новым всегда: ассистент разбирает письма в порядке постановки в очередь,
  // и более раннее письмо клиента должно встать туда первым — тогда следующее заберёт его в свой
  // ответ (`emailHandler.ts`), а не окажется разобрано раньше него.
  const full = res.data.length >= PAGE_LIMIT;
  const sorted = [...res.data].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
  const batch = full ? sorted.slice(0, -1) : sorted;

  let stored = 0;
  let matched = 0;

  for (const m of batch) {
    // Письмо, которое мы уже видели, не трогаем повторно: заказ у него мог быть привязан вручную
    // или изменён, и перезапись затёрла бы это без причины.
    const exists = await prisma.orderEmailMessage.findUnique({ where: { providerMessageId: m.id }, select: { id: true } });
    if (exists) continue;

    const orderId = await resolveOrderId(prisma, m);
    const created = await prisma.orderEmailMessage.create({
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
      select: { id: true },
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

    // Ассистент магазина включён — письмо разбирает он (29.09.2026): ответ клиенту или черновик
    // людям. Уведомление «клиент ответил» он пришлёт сам, если отвечать не станет.
    const assistantOn = await prisma.order.findUnique({ where: { id: orderId }, select: { site: { select: { aiMode: true } } } });
    if (assistantOn && assistantOn.site.aiMode !== "OFF") {
      await publishAssistantEmail(new PrismaOutboxRepository(prisma), created.id);
      continue;
    }
    await publishTelegramNotification(prisma, {
      type: "customer.email_reply",
      orderId,
      occurrenceKey: m.id,
      context: { from: m.fromEmail, subject: m.subject ?? "", quote: emailQuoteForTelegram(m.text) },
    });
  }

  return { fetched: res.data.length, stored, matched, skipped: full ? "page_full" : null };
}
