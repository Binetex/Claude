import "server-only";
/**
 * Исходящая отправка SMS через QUO. Жизненный цикл записи OrderCommunication:
 *   PENDING (до вызова QUO) → SENT (успех, сохранён message/conversation id) → DELIVERED (webhook)
 *                                    └→ FAILED (ошибка QUO, безопасный код без секретов)
 * Идемпотентность — durable: уникальный app-level sendKey (двойной клик/повтор формы не создаёт дубль
 * и НЕ отправляет второй раз). Ключ ОДНОРАЗОВЫЙ: после FAILED повтор с ним же — это не «уже
 * отправлено», а `previous_attempt_failed`; новая попытка обязана прийти с новым ключом. Клиент должен быть создан БЕЗ авто-ретрая (maxRetries:0), чтобы не
 * повторять POST при неоднозначной сетевой ошибке (неизвестно, принял ли QUO). PII в логи не пишем.
 */
import { existsSync, statSync } from "node:fs";
import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import type { QuoClient } from "./client";
import { uploadedFilePath } from "@/lib/storage";
import { bouquetMediaName } from "@/lib/bouquetPage";
import { QuoApiError } from "./errors";
import { toE164 } from "@/lib/phone";
import { maskPhone, quoLog } from "./logging";
import { isP2002 } from "@/lib/prismaErrors";
import { isQuoOutOfMoney, alertQuoOutOfMoney } from "./balanceAlert";
import { toSmsText, smsSegments } from "@/lib/smsText";
import { PrismaOutboxRepository } from "@/outbox/prismaRepository";
import type { OutboxHandler } from "@/outbox/worker";
import { smsTransport, type SmsTransport, type BrowserSender, type BrowserSendResult } from "./browser/transport";

export const SMS_MAX_LENGTH = 1600;
export type SendTarget = "CUSTOMER" | "RECIPIENT";

export type SendSmsInput = {
  orderId: string;
  target: SendTarget;
  text: string;
  idempotencyKey: string;
  sentByUserId?: string | null;
  /**
   * Это ОТВЕТ на входящее от того же человека. Запрет «не писать получателю» (сюрприз) такой
   * ответ не гасит: получатель написал нам сам, сюрприз он уже раскрыл, и молчание в ответ на
   * прямой вопрос хуже любого сюрприза. Ставится только там, где входящее действительно есть.
   */
  replyToInbound?: boolean;
  /** Картинки к сообщению (MMS): фото букета, вложение из переписки карточки. Текст тогда может быть пустым. */
  attachments?: SmsAttachment[];
};

/**
 * Картинка к SMS — файл из загруженных (`/api/media/<name>`). Уходит ТОЛЬКО браузером Quo: в их API
 * вложений нет (владелец 07.10.2026: «раз мы теперь используем браузер»). Не вышло браузером до
 * нажатия «Отправить» — сообщение уходит через API текстом, а вместо картинки — ссылка `fallbackUrl`.
 */
export type SmsAttachment = { name: string; fallbackUrl: string };
/** Как вложение лежит в `OrderCommunication.attachmentsJson` — тот же вид, что у входящих MMS. */
type StoredAttachment = { url: string; type: string; fallbackUrl: string };

/** MMS везут не всё: JPEG, PNG и GIF доходят на любой телефон. */
const MMS_TYPES: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif" };
/** Больше операторы режут или не доставляют; наши фото после сжатия — сотни килобайт. */
const MMS_MAX_BYTES = 5 * 1024 * 1024;

function storeAttachments(list: SmsAttachment[] | undefined): { ok: true; list: StoredAttachment[] } | { ok: false; code: string } {
  const out: StoredAttachment[] = [];
  for (const a of list ?? []) {
    const file = uploadedFilePath(a.name);
    const type = MMS_TYPES[a.name.split(".").pop()?.toLowerCase() ?? ""];
    if (!file || !type) return { ok: false, code: "attachment_unsupported" };
    let size: number;
    try {
      size = statSync(file).size;
    } catch {
      return { ok: false, code: "attachment_missing" };
    }
    if (size > MMS_MAX_BYTES) return { ok: false, code: "attachment_too_large" };
    out.push({ url: `/api/media/${a.name}`, type, fallbackUrl: a.fallbackUrl });
  }
  return { ok: true, list: out };
}

/** Записанные вложения обратно (воркер получает сообщение из записи). Чужие записи (входящие MMS) не подходят. */
function storedAttachments(json: unknown): StoredAttachment[] {
  if (!Array.isArray(json)) return [];
  return json.flatMap((x) => {
    const a = x as Partial<StoredAttachment> | null;
    return a && typeof a.url === "string" && typeof a.fallbackUrl === "string" ? [{ url: a.url, type: typeof a.type === "string" ? a.type : "image/jpeg", fallbackUrl: a.fallbackUrl }] : [];
  });
}

/** Текст, который уходит, если картинки пришлось заменить ссылками. */
const withLinks = (text: string, list: { fallbackUrl: string }[]) => [text, ...list.map((a) => a.fallbackUrl)].filter(Boolean).join("\n");

/** Заказ помечен «получателю не писать»: отправка не сбой, а запрет владельца. */
export const RECIPIENT_MUTED_CODE = "recipient_muted";
export type SendSmsResult =
  | { ok: true; communicationId: string; status: "PENDING" | "SENT"; duplicate: boolean }
  /** `detail` — ответ провайдера «402» или «402:0201402»: по нему видно, что именно чинить. */
  | { ok: false; code: string; communicationId?: string; detail?: string };


export async function sendOrderSms(prisma: PrismaClient, client: QuoClient | null, input: SendSmsInput): Promise<SendSmsResult> {
  // Единственная очистка перед Quo: ’ “ … эмодзи á переводят ВСЁ сообщение в части по 70 знаков
  // вместо 160 — и Quo берёт за него вдвое-втрое больше (lib/smsText.ts). Записываем то, что ушло.
  const text = toSmsText(input.text ?? "");
  const attached = storeAttachments(input.attachments);
  if (!attached.ok) return { ok: false, code: attached.code };
  const attachments = attached.list;
  if (!text && !attachments.length) return { ok: false, code: "empty_text" };
  // Длина — с запасом на ссылки: без браузера картинки уйдут ими.
  if (withLinks(text, attachments).length > SMS_MAX_LENGTH) return { ok: false, code: "too_long" };
  if (!input.idempotencyKey) return { ok: false, code: "missing_idempotency_key" };

  const order = await prisma.order.findUnique({
    where: { id: input.orderId },
    select: { id: true, senderPhone: true, recipientPhone: true, recipientMuted: true, site: { select: { quoPhoneNumberId: true, quoPhoneNumber: true, quoEnabled: true } } },
  });
  if (!order) return { ok: false, code: "order_not_found" };

  const e164 = toE164(input.target === "CUSTOMER" ? order.senderPhone : order.recipientPhone);
  if (!e164) return { ok: false, code: "invalid_target_phone" };

  // Сюрприз: по этому заказу получателю мы сами не пишем. Здесь единственная дверь наружу для
  // SMS по заказу, поэтому проверка одна и закрывает всё: автоматизации, ручную отправку из
  // карточки, всё, что появится потом.
  //
  // Сверяем НОМЕР, а не роль. Когда заказчик указал свой телефон и в billing, и в доставке,
  // «получатель» — это он сам, и запрет заткнул бы переписку с плательщиком (ту же поправку
  // делает resolveRecipients в автоматизациях).
  if (order.recipientMuted && input.target === "RECIPIENT" && !input.replyToInbound && e164 !== toE164(order.senderPhone)) {
    quoLog("sms.recipient_muted", { orderId: order.id, phone: maskPhone(e164) });
    return { ok: false, code: RECIPIENT_MUTED_CODE };
  }

  const fromId = order.site?.quoPhoneNumberId ?? null;
  if (!fromId) return { ok: false, code: "store_no_quo_number" }; // не отправляем без номера магазина
  if (!order.site?.quoEnabled) return { ok: false, code: "store_quo_disabled" }; // магазин отключён
  if (!client) return { ok: false, code: "quo_not_configured" };

  // Durable идемпотентность: PENDING-запись с уникальным sendKey. P2002 → уже отправляли.
  let pendingId: string;
  try {
    const pending = await prisma.orderCommunication.create({
      data: {
        orderId: order.id, provider: "QUO", type: "SMS", direction: "OUTBOUND",
        partyRole: input.target, status: "PENDING",
        storePhone: order.site?.quoPhoneNumber ?? null, externalPhone: e164, externalPhoneNormalized: e164,
        messageText: text, providerPhoneNumberId: fromId, occurredAt: new Date(),
        sendKey: input.idempotencyKey, sentByUserId: input.sentByUserId ?? null,
        // Картинки — сразу в запись: лента карточки показывает их, как у входящих MMS.
        ...(attachments.length ? { attachmentsJson: attachments } : {}),
      },
      select: { id: true },
    });
    pendingId = pending.id;
  } catch (err) {
    if (isP2002(err)) {
      const existing = await prisma.orderCommunication.findUnique({ where: { sendKey: input.idempotencyKey }, select: { id: true, status: true } });
      if (existing) {
        // Прошлая попытка с ЭТИМ ключом провалилась — сообщение не ушло. Отвечать «дубликат-успех»
        // нельзя: отправитель решит, что клиента уведомили, а SMS нет и не будет. Повтор возможен
        // только с НОВЫМ ключом (новая попытка), поэтому здесь честная ошибка.
        if (existing.status === "FAILED") {
          quoLog("sms.duplicate_of_failed", { communicationId: existing.id });
          return { ok: false, code: "previous_attempt_failed", communicationId: existing.id };
        }
        quoLog("sms.duplicate_request", { communicationId: existing.id });
        return { ok: true, communicationId: existing.id, status: existing.status === "PENDING" ? "PENDING" : "SENT", duplicate: true };
      }
    }
    throw err;
  }

  return dispatch(prisma, client, smsTransport(), { pendingId, fromId, to: e164, text, target: input.target, attachments });
}

/** «402» или «402:0201402» — статус ответа провайдера и его собственный код ошибки. */
function providerDetail(err: unknown): string | undefined {
  if (!(err instanceof QuoApiError) || !err.status) return undefined;
  return err.safeCode ? `${err.status}:${err.safeCode}` : String(err.status);
}

export type SendUnlinkedSmsInput = {
  siteId: string;
  toPhone: string;
  text: string;
  idempotencyKey: string;
  /** Заказ, к которому отнести запись: разговор привязан, но пишет номер, которого в заказе нет. */
  orderId?: string | null;
  /** Кто из сотрудников отправил — иначе ответ из «Других сообщений» окажется в ленте без автора. */
  sentByUserId?: string | null;
  /**
   * Отправить С КОНКРЕТНОГО номера магазина, а не с основного. Нужно «Другим сообщениям»:
   * если человек написал на второй номер магазина, ответ обязан уйти с него же — иначе он
   * увидит ответ с незнакомого номера. Значение проверяется: чужой номер не принимается.
   */
  fromPhoneNumberId?: string | null;
};

/**
 * SMS человеку, у которого НЕТ заказа: ответ ассистента незнакомому номеру.
 *
 * Тот же путь, что у `sendOrderSms` — PENDING-запись с уникальным sendKey, вызов QUO, SENT или
 * FAILED, — только без заказа: запись остаётся в «Нераспознанных» и привяжется, когда заказ
 * найдётся. Второго способа отправить SMS в проекте нет и не должно быть.
 */
export async function sendUnlinkedSms(prisma: PrismaClient, client: QuoClient | null, input: SendUnlinkedSmsInput): Promise<SendSmsResult> {
  const text = toSmsText(input.text ?? ""); // та же очистка, что в sendOrderSms
  if (!text) return { ok: false, code: "empty_text" };
  if (text.length > SMS_MAX_LENGTH) return { ok: false, code: "too_long" };
  if (!input.idempotencyKey) return { ok: false, code: "missing_idempotency_key" };

  const e164 = toE164(input.toPhone);
  if (!e164) return { ok: false, code: "invalid_target_phone" };

  const site = await prisma.site.findUnique({
    where: { id: input.siteId },
    select: {
      quoPhoneNumberId: true, quoPhoneNumber: true, quoEnabled: true,
      quoExtraNumbers: { select: { quoPhoneNumberId: true, quoPhoneNumber: true } },
    },
  });
  if (!site?.quoPhoneNumberId) return { ok: false, code: "store_no_quo_number" };
  if (!site.quoEnabled) return { ok: false, code: "store_quo_disabled" };

  // Отправитель: запрошенный номер, если он ДЕЙСТВИТЕЛЬНО принадлежит этому магазину, иначе
  // основной. Проверка обязательна: без неё параметром можно было бы отправить с чужого номера.
  const requested = input.fromPhoneNumberId ?? null;
  const extra = requested ? site.quoExtraNumbers.find((n) => n.quoPhoneNumberId === requested) : undefined;
  const useExtra = !!requested && requested !== site.quoPhoneNumberId && !!extra;
  // Отдельный код, а не store_no_quo_number: номер у магазина есть, просто просят чужой.
  if (requested && requested !== site.quoPhoneNumberId && !extra) return { ok: false, code: "from_number_not_owned" };
  const fromId = useExtra ? requested! : site.quoPhoneNumberId;
  const fromNumber = useExtra ? extra!.quoPhoneNumber ?? null : site.quoPhoneNumber ?? null;
  if (!client) return { ok: false, code: "quo_not_configured" };

  let pendingId: string;
  try {
    const pending = await prisma.orderCommunication.create({
      data: {
        orderId: input.orderId ?? null, provider: "QUO", type: "SMS", direction: "OUTBOUND",
        partyRole: "UNKNOWN", status: "PENDING",
        storePhone: fromNumber, externalPhone: e164, externalPhoneNormalized: e164,
        messageText: text, providerPhoneNumberId: fromId, occurredAt: new Date(),
        sendKey: input.idempotencyKey, sentByUserId: input.sentByUserId ?? null,
      },
      select: { id: true },
    });
    pendingId = pending.id;
  } catch (err) {
    if (isP2002(err)) {
      const existing = await prisma.orderCommunication.findUnique({ where: { sendKey: input.idempotencyKey }, select: { id: true, status: true } });
      if (existing) {
        if (existing.status === "FAILED") return { ok: false, code: "previous_attempt_failed", communicationId: existing.id };
        return { ok: true, communicationId: existing.id, status: existing.status === "PENDING" ? "PENDING" : "SENT", duplicate: true };
      }
    }
    throw err;
  }

  return dispatch(prisma, client, smsTransport(), { pendingId, fromId, to: e164, text, target: "UNKNOWN", attachments: [] });
}

/** Записанное PENDING-сообщение, которое осталось отправить. */
type Outgoing = { pendingId: string; fromId: string; to: string; text: string; target: string; attachments: StoredAttachment[] };

/**
 * Отправка записанного PENDING-сообщения: браузером Quo (входит в подписку, `browser/transport.ts`),
 * через воркер (Next.js браузер не держит) или через API — по-старому и запасным путём.
 */
async function dispatch(prisma: PrismaClient, client: QuoClient, t: SmsTransport, o: Outgoing): Promise<SendSmsResult> {
  if (t.via === "worker") return handOverToWorker(prisma, o);
  if (t.via === "browser") {
    const sent = await sendViaBrowser(prisma, t.send, o);
    if (sent) return sent;
  }
  return sendViaApi(prisma, client, o.attachments.length ? await asLinks(prisma, o) : o);
}

/**
 * API картинок не возит: вместо них — ссылки в тексте. Запись честно показывает, что ушло: текст со
 * ссылками и без картинок, иначе лента карточки рисовала бы MMS, которого клиент не получал.
 */
async function asLinks(prisma: PrismaClient, o: Outgoing): Promise<Outgoing> {
  const text = withLinks(o.text, o.attachments);
  await prisma.orderCommunication.update({ where: { id: o.pendingId }, data: { messageText: text, attachmentsJson: Prisma.DbNull } });
  quoLog("sms.attachments_as_links", { communicationId: o.pendingId, count: o.attachments.length });
  return { ...o, text, attachments: [] };
}

/** Вызов QUO API. Клиент без авто-ретрая: неоднозначную сетевую/5xx ошибку не повторяем автоматически. */
async function sendViaApi(prisma: PrismaClient, client: QuoClient, o: Outgoing): Promise<SendSmsResult> {
  try {
    const res = await client.sendMessage({ content: o.text, from: o.fromId, to: [o.to] });
    await prisma.orderCommunication.update({
      where: { id: o.pendingId },
      data: { status: "SENT", providerResourceId: res.id, providerConversationId: res.conversationId, occurredAt: new Date() },
    });
    quoLog("sms.sent", { communicationId: o.pendingId, target: o.target, phone: maskPhone(o.to), resourceId: res.id, via: "api", textLen: o.text.length, segments: smsSegments(o.text).segments });
    return { ok: true, communicationId: o.pendingId, status: "SENT", duplicate: false };
  } catch (err) {
    const kind = err instanceof QuoApiError ? err.kind : "network";
    const safeCode = err instanceof QuoApiError ? `${err.kind}:${err.status}` : "network:0";
    // Код из тела ответа («0201402» — истёкшая подписка) — единственное, с чем можно идти в
    // поддержку Quo. Без него в журнале оставалось только «client:402». `code` — тот же код, что
    // получает вызывающий: по нему Next.js читает исход отправки, сделанной воркером.
    const detail = providerDetail(err);
    await prisma.orderCommunication.update({ where: { id: o.pendingId }, data: { status: "FAILED", rawMetadata: { error: safeCode, providerCode: detail ?? null, code: `quo_${kind}` } } });
    quoLog("sms.failed", { communicationId: o.pendingId, target: o.target, phone: maskPhone(o.to), errorCode: safeCode, providerCode: detail });
    // Пустой баланс QUO останавливает ВСЕ SMS магазина, а не одно сообщение: владелец должен
    // узнать об этом сразу, а не из журнала через неделю.
    if (isQuoOutOfMoney(detail)) await alertQuoOutOfMoney(prisma);
    return { ok: false, code: `quo_${kind}`, communicationId: o.pendingId, detail };
  }
}

/** Отметка «ушло браузером»: id сообщения у такой записи нет, его приносит вебхук Quo. */
function isBrowserMarked(raw: unknown): boolean {
  return !!raw && typeof raw === "object" && (raw as { via?: unknown }).via === "browser";
}

/**
 * Браузером Quo. null — до «Отправить» не дошли (не вошёл, ящик не открылся, номер не принят):
 * сообщение уходит через API. Кнопку нажали — второго пути нет: при сомнении сообщение считается
 * ушедшим, а подтверждает его вебхук Quo (`ingest.ts`, сверка по номеру и тексту).
 */
async function sendViaBrowser(prisma: PrismaClient, send: BrowserSender, o: Outgoing): Promise<SendSmsResult | null> {
  // Каждой картинке — свой файл на диске. Не нашёлся хоть один — браузером не шлём: ушло бы без
  // картинки, а лента показала бы её. Через API уйдут ссылки.
  const files = o.attachments.map((a) => uploadedFilePath(bouquetMediaName(a.url) ?? ""));
  if (files.some((f) => !f || !existsSync(f))) {
    quoLog("sms.browser_fallback", { communicationId: o.pendingId, reason: "attachment_missing" });
    return null;
  }
  let pressed = false;
  let r: BrowserSendResult;
  try {
    r = await send({
      fromPhoneNumberId: o.fromId,
      to: o.to,
      text: o.text,
      files: files as string[],
      // Отметка ДО нажатия: упади воркер сразу после него, повтор задачи второй раз не отправит
      // (`buildQuoSmsSendHandler`), а вебхук найдёт запись по ней.
      beforeSend: async () => {
        pressed = true;
        await prisma.orderCommunication.update({ where: { id: o.pendingId }, data: { rawMetadata: { via: "browser" } } });
      },
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    r = pressed ? { outcome: "unknown", reason } : { outcome: "not_sent", reason };
  }
  if (r.outcome === "not_sent") {
    quoLog("sms.browser_fallback", { communicationId: o.pendingId, reason: r.reason.slice(0, 200) });
    return null;
  }
  const unconfirmed = r.outcome === "unknown" ? r.reason.slice(0, 200) : null;
  // Только из PENDING: вебхук мог успеть раньше и поставить DELIVERED — назад не откатываем.
  await prisma.orderCommunication.updateMany({
    where: { id: o.pendingId, status: "PENDING" },
    data: { status: "SENT", occurredAt: new Date(), rawMetadata: unconfirmed ? { via: "browser", unconfirmed } : { via: "browser" } },
  });
  quoLog("sms.sent", { communicationId: o.pendingId, target: o.target, phone: maskPhone(o.to), via: "browser", unconfirmed: !!unconfirmed, textLen: o.text.length, segments: smsSegments(o.text).segments, attachments: o.attachments.length });
  return { ok: true, communicationId: o.pendingId, status: "SENT", duplicate: false };
}

/** Сколько Next.js ждёт воркер: кнопка «Отправить» в карточке крутится, пока робот печатает. */
const HANDOVER_WAIT_MS = 30_000;
const HANDOVER_POLL_MS = 500;

/**
 * Next.js браузера не держит: отправку делает воркер (`buildQuoSmsSendHandler`, тот же `dispatch`),
 * а здесь ждём исход, чтобы карточка показала «отправлено» или ошибку, как раньше. Не дождались
 * (воркер разбирает утреннюю пачку) — в ленте сообщение «отправляется» и уйдёт в свою очередь.
 */
async function handOverToWorker(prisma: PrismaClient, o: Outgoing): Promise<SendSmsResult> {
  await new PrismaOutboxRepository(prisma).enqueue({
    eventType: QUO_SMS_SEND_EVENT,
    aggregateType: "communication",
    aggregateId: o.pendingId,
    payload: { communicationId: o.pendingId },
    idempotencyKey: `quo-sms-send:${o.pendingId}`,
  });
  const deadline = Date.now() + HANDOVER_WAIT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, HANDOVER_POLL_MS));
    const row = await prisma.orderCommunication.findUnique({ where: { id: o.pendingId }, select: { status: true, rawMetadata: true } });
    if (!row || row.status === "PENDING") continue;
    if (row.status === "FAILED") {
      const m = (row.rawMetadata ?? {}) as { code?: string; providerCode?: string | null };
      return { ok: false, code: m.code ?? "quo_failed", communicationId: o.pendingId, detail: m.providerCode ?? undefined };
    }
    return { ok: true, communicationId: o.pendingId, status: "SENT", duplicate: false };
  }
  return { ok: true, communicationId: o.pendingId, status: "PENDING", duplicate: false };
}

export const QUO_SMS_SEND_EVENT = "quo.sms.send";

/**
 * Воркер: отправить сообщение, записанное в Next.js (`handOverToWorker`). Отправка та же — браузер,
 * при неудаче API. Запись уже не PENDING — исход решён раньше, повтор задачи ничего не делает.
 */
export function buildQuoSmsSendHandler(
  prisma: PrismaClient,
  deps: { client: () => QuoClient | null; browser: () => BrowserSender | null },
): OutboxHandler {
  return async (record) => {
    const id = (record.payload as { communicationId?: unknown } | null)?.communicationId;
    if (typeof id !== "string") return;
    const row = await prisma.orderCommunication.findUnique({
      where: { id },
      select: { id: true, status: true, type: true, direction: true, providerPhoneNumberId: true, externalPhoneNormalized: true, messageText: true, partyRole: true, rawMetadata: true, attachmentsJson: true },
    });
    if (!row || row.status !== "PENDING" || row.type !== "SMS" || row.direction !== "OUTBOUND") return;
    // Прошлый заход успел нажать «Отправить» и не дожил до ответа: второй раз не шлём.
    if (isBrowserMarked(row.rawMetadata)) {
      await prisma.orderCommunication.updateMany({ where: { id, status: "PENDING" }, data: { status: "SENT", rawMetadata: { via: "browser", unconfirmed: "worker_restarted" } } });
      return;
    }
    const client = deps.client();
    const attachments = storedAttachments(row.attachmentsJson);
    if (!client || !row.providerPhoneNumberId || (!row.messageText && !attachments.length)) {
      await prisma.orderCommunication.update({ where: { id }, data: { status: "FAILED", rawMetadata: { code: "quo_not_configured" } } });
      return;
    }
    const browser = deps.browser();
    await dispatch(prisma, client, browser ? { via: "browser", send: browser } : { via: "api" }, {
      pendingId: row.id,
      fromId: row.providerPhoneNumberId,
      to: row.externalPhoneNormalized,
      text: row.messageText ?? "",
      target: row.partyRole,
      attachments,
    });
  };
}
