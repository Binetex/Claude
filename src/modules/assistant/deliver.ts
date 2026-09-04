import "server-only";
/**
 * Отправка ответа ассистента клиенту и показ черновика в Telegram.
 *
 * Своего пути наружу здесь нет: SMS уходит тем же `sendOrderSms`, что и ручной ответ из карточки
 * заказа, — с теми же проверками магазина, номера и идемпотентности. Ключ идемпотентности —
 * сам разбор: повторное нажатие кнопки в Telegram второго сообщения не создаёт.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { getQuoConfig } from "@/integrations/quo/config";
import { createQuoClient, type QuoClient } from "@/integrations/quo/client";
import { sendOrderSms, sendUnlinkedSms } from "@/integrations/quo/send";
import { resolveOwnerBot, resolveFloristBot, type BotLookup } from "@/integrations/telegram/bots";
import { isTelegramGloballyEnabled } from "@/integrations/telegram/config";
import { TelegramSender } from "@/integrations/telegram/sender";
import { pickRecipient, storeHour } from "./routing";
import { parseAttachments } from "@/integrations/quo/communicationsService";
import { NUDGE_AFTER_MIN } from "./events";

export type DeliverResult = { ok: true } | { ok: false; code: string };

/** Кнопка подтверждения: одно нажатие вместо печати ответа. */
export const SEND_ACTION_PREFIX = "ai:send:";
/** Кнопка «не отправлять»: черновик закрывается, клиенту не уходит ничего. */
export const DISCARD_ACTION_PREFIX = "ai:discard:";

/** Текст клиенту и Telegram-сообщения — данные, а не разметка: `<3` в SMS ломал бы HTML. */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * QUO-клиент без авто-ретрая: `sendOrderSms` считает повтор новой попыткой с новым ключом, а
 * встроенный ретрай слал бы клиенту одно и то же дважды. Тот же вызов, что в воркере и карточке.
 */
function quoClient(): QuoClient | null {
  const cfg = getQuoConfig();
  return cfg ? createQuoClient({ ...cfg, maxRetries: 0 }) : null;
}

/**
 * Кому именно отвечать в заказе: сравниваем номер входящего с номерами заказа. partyRole
 * устаревает, когда телефон в заказе правят, поэтому он — запасной вариант, а не первый.
 * `null` — номер входящего не совпал ни с одной стороной: пишет кто-то третий, и отвечать
 * ему через «заказчика» значит отправить SMS не тому человеку.
 */
export function pickOrderTarget(
  incomingPhone: string | null,
  partyRole: string,
  order: { senderPhone: string | null; recipientPhone: string | null }
): "CUSTOMER" | "RECIPIENT" | null {
  if (incomingPhone && order.recipientPhone && incomingPhone === order.recipientPhone) return "RECIPIENT";
  if (incomingPhone && order.senderPhone && incomingPhone === order.senderPhone) return "CUSTOMER";
  if (incomingPhone) return null;
  return partyRole === "RECIPIENT" ? "RECIPIENT" : "CUSTOMER";
}

/**
 * Отправляет готовый текст разбора клиенту. Адресат — тот, кто написал: отвечаем в тот же
 * разговор, а не «заказчику по умолчанию».
 */
export async function sendAssistantReply(prisma: PrismaClient, turnId: string, decidedByUserId?: string): Promise<DeliverResult> {
  const turn = await prisma.aiTurn.findUnique({
    where: { id: turnId },
    select: {
      id: true, status: true, replyText: true, orderId: true, siteId: true,
      site: { select: { aiDryRun: true, aiMode: true } },
      communication: { select: { partyRole: true, externalPhoneNormalized: true } },
      order: { select: { senderPhone: true, recipientPhone: true, aiDisabled: true } },
    },
  });
  if (!turn) return { ok: false, code: "turn_not_found" };
  // Повторное нажатие кнопки или гонка двух воркеров: отправляем только из черновика.
  if (turn.status !== "DRAFT") return { ok: false, code: "already_decided" };
  if (!turn.replyText?.trim()) return { ok: false, code: "no_text" };
  // Сухой прогон означает «наружу не уходит ничего» — включая нажатие кнопки. Выключенный
  // ассистент или выключатель на заказе после создания черновика — то же самое.
  if (turn.site.aiDryRun) return { ok: false, code: "dry_run" };
  if (turn.site.aiMode === "OFF") return { ok: false, code: "assistant_off" };
  if (turn.order?.aiDisabled) return { ok: false, code: "order_disabled" };

  const text = turn.replyText.trim();
  const incomingPhone = turn.communication.externalPhoneNormalized;
  const target = turn.order ? pickOrderTarget(incomingPhone, turn.communication.partyRole, turn.order) : null;

  // Без заказа, или пишет номер, которого в заказе нет: отвечаем в тот же номер от номера
  // магазина. Запись при этом относится к заказу, если он есть — разговор-то его.
  const res = target
    ? await sendOrderSms(prisma, quoClient(), { orderId: turn.orderId!, target, text, idempotencyKey: `ai-turn:${turn.id}` })
    : await sendUnlinkedSms(prisma, quoClient(), {
        siteId: turn.siteId, toPhone: incomingPhone, text, idempotencyKey: `ai-turn:${turn.id}`, orderId: turn.orderId,
      });
  if (!res.ok) return { ok: false, code: res.code };

  await prisma.aiTurn.update({
    where: { id: turn.id },
    data: { status: "SENT", sentCommunicationId: res.communicationId ?? null, decidedAt: new Date(), decidedByUserId: decidedByUserId ?? null },
  });
  return { ok: true };
}

/** Человек решил не отвечать: черновик закрывается, напоминание «one moment» больше не уйдёт. */
export async function discardAssistantReply(prisma: PrismaClient, turnId: string, decidedByUserId?: string): Promise<DeliverResult> {
  const r = await prisma.aiTurn.updateMany({
    where: { id: turnId, status: "DRAFT" },
    data: { status: "DISCARDED", decidedAt: new Date(), decidedByUserId: decidedByUserId ?? null },
  });
  return r.count === 1 ? { ok: true } : { ok: false, code: "already_decided" };
}

/** Короткая выжимка для Telegram: длинные простыни в чате никто не читает. */
function clip(text: string, limit: number): string {
  const t = text.trim().replace(/\s+/g, " ");
  return t.length > limit ? `${t.slice(0, limit - 1)}…` : t;
}

/**
 * Показывает черновик тому, кто сейчас отвечает: до полудня владельцу, после — флористу заказа.
 * В сухом прогоне — тоже, с пометкой: так весь путь до кнопки проверяется без риска для клиента.
 * У флориста нет бота — владельцу: черновик, который никто не увидел, это молчание магазина.
 * Возвращает false, если показать некому — тогда черновик остаётся только в карточке заказа.
 */
export async function notifyDraft(prisma: PrismaClient, turnId: string, now = new Date()): Promise<boolean> {
  if (!(await isTelegramGloballyEnabled(prisma))) return false;
  const turn = await prisma.aiTurn.findUnique({
    where: { id: turnId },
    select: {
      id: true, replyText: true, important: true, needsHuman: true, intent: true,
      site: { select: { name: true, timezone: true, aiDryRun: true } },
      order: { select: { orderNumber: true, currentFloristId: true, site: { select: { timezone: true } } } },
      communication: { select: { messageText: true, transcript: true, externalPhone: true, attachmentsJson: true } },
    },
  });
  if (!turn) return false;
  // Фото клиента человек обязан увидеть: модель его не видит, и решение — по картинке.
  const photos = parseAttachments(turn.communication.attachmentsJson).map((a) => a.url);

  // Незнакомый номер идёт только владельцу: флориста у разговора без заказа нет. Сухой прогон —
  // тоже только владельцу: проверяет ассистента он, а флористу пробные черновики с пометкой
  // «клиенту не уйдёт» только мешают.
  let who = turn.order && !turn.site.aiDryRun
    ? pickRecipient({ storeHour: storeHour(turn.order.site?.timezone, now), hasFlorist: !!turn.order.currentFloristId })
    : "OWNER";
  let lookup: BotLookup =
    who === "FLORIST" && turn.order?.currentFloristId
      ? await resolveFloristBot(prisma, turn.order.currentFloristId)
      : await resolveOwnerBot(prisma);
  if (!("bot" in lookup) && who === "FLORIST") {
    who = "OWNER";
    lookup = await resolveOwnerBot(prisma);
  }
  if (!("bot" in lookup)) return false;

  const incoming = escapeHtml(clip(turn.communication.messageText ?? turn.communication.transcript ?? "", 400));
  const draft = turn.replyText?.trim();
  const head = `${turn.site.aiDryRun ? "🧪 Сухой прогон · " : ""}${turn.important ? "❗ Важное сообщение от клиента" : "Сообщение от клиента"}`;
  const where = turn.order
    ? `заказ ${escapeHtml(turn.order.orderNumber)}`
    : `незнакомый номер ${escapeHtml(turn.communication.externalPhone)} · ${escapeHtml(turn.site.name)}`;
  const lines = [
    `<b>${head}</b> · ${where}`,
    "",
    `Клиент: ${incoming || (photos.length ? "(фото без текста)" : "")}`,
    ...photos.map((u, i) => `Фото ${photos.length > 1 ? i + 1 : ""}: ${escapeHtml(u)}`.replace("Фото :", "Фото:")),
    "",
    draft ? `Ответ ассистента:\n${escapeHtml(draft)}` : "Ассистент не смог ответить — нужен человек.",
    "",
    turn.site.aiDryRun
      ? "Сухой прогон: кнопки и ответы работают, но клиенту ничего не уйдёт."
      : draft
        ? `Нажмите «Отправить» или ответьте на это сообщение своим текстом. Без решения через ${NUDGE_AFTER_MIN} мин клиенту уйдёт «one moment».`
        : `Ответьте на это сообщение своим текстом. Без ответа через ${NUDGE_AFTER_MIN} мин клиенту уйдёт «one moment».`,
  ];

  const sender = new TelegramSender(lookup.bot.token);
  const res = await sender.sendMessage(lookup.bot.chatId, lines.join("\n"), [
    ...(draft ? [{ text: "Отправить", callbackData: `${SEND_ACTION_PREFIX}${turn.id}` }] : []),
    { text: "Не отвечать", callbackData: `${DISCARD_ACTION_PREFIX}${turn.id}` },
  ]);
  if (!res.ok) return false;

  await prisma.aiTurn.update({
    where: { id: turn.id },
    data: { telegramChatId: lookup.bot.chatId, telegramMessageId: res.messageId },
  });

  // Важное владелец узнаёт всегда, даже когда черновик ушёл флористу: отмена, возврат, жалоба —
  // это его решения. Копия без кнопки: подтверждает тот, у кого черновик, а владелец при желании
  // открывает заказ. Сбой копии черновик не отменяет.
  if (turn.important && who === "FLORIST" && turn.order) {
    const owner = await resolveOwnerBot(prisma);
    if ("bot" in owner) {
      await new TelegramSender(owner.bot.token)
        .sendMessage(owner.bot.chatId, `<b>❗ Важное от клиента</b> · заказ ${escapeHtml(turn.order.orderNumber)}\n\n${incoming}\n\nЧерновик ответа ушёл флористу.`)
        .catch(() => null);
    }
  }
  return true;
}

/**
 * Служебный сигнал владельцу мимо реестра событий: тот привязан к заказу, а «кончился баланс
 * модели» — про систему. Один раз: повторы гасит вызывающий.
 */
export async function notifyOwnerText(prisma: PrismaClient, text: string): Promise<boolean> {
  if (!(await isTelegramGloballyEnabled(prisma))) return false;
  const owner = await resolveOwnerBot(prisma);
  if (!("bot" in owner)) return false;
  const res = await new TelegramSender(owner.bot.token).sendMessage(owner.bot.chatId, text).catch(() => null);
  return !!res?.ok;
}

/** Нейтральный текст, когда человек не успел ответить. Один раз и коротко. */
export const NUDGE_TEXT = "One moment, we are checking on this and will get right back to you.";

/** Опоздавшее напоминание не шлём: «одну минуту» через сутки после вопроса хуже молчания. */
export const NUDGE_LATE_TOLERANCE_MIN = 60;

/**
 * Клиент написал, черновик ждёт человека, а человек занят. Через двадцать минут отправляем одно
 * нейтральное сообщение: молчание магазина читается хуже, чем «сейчас посмотрим».
 *
 * Сам черновик при этом остаётся черновиком: настоящий ответ всё ещё за человеком. Но если
 * человек за это время ответил клиенту сам — из карточки заказа или из QUO, — «одну минуту»
 * после настоящего ответа выглядит сбоем, и мы молчим.
 */
export function buildAssistantNudgeHandler(prisma: PrismaClient, deps: { now?: () => Date } = {}) {
  const now = deps.now ?? (() => new Date());
  return async (record: { payload: unknown }): Promise<void> => {
    const p = record.payload as { turnId?: string; dueAt?: string };
    if (!p?.turnId) return;
    if (p.dueAt) {
      const late = (now().getTime() - new Date(p.dueAt).getTime()) / 60_000;
      if (late > NUDGE_LATE_TOLERANCE_MIN) return;
    }

    const turn = await prisma.aiTurn.findUnique({
      where: { id: p.turnId },
      select: {
        id: true, status: true, orderId: true, siteId: true, createdAt: true,
        site: { select: { aiDryRun: true, aiMode: true } },
        communication: { select: { partyRole: true, externalPhoneNormalized: true, storePhone: true } },
        order: { select: { senderPhone: true, recipientPhone: true, orderStatus: true, deliveryStatus: true, aiDisabled: true } },
      },
    });
    // Ответили, отказались, выключили или сухой прогон — говорить «одну минуту» уже незачем.
    if (!turn || turn.status !== "DRAFT" || turn.site.aiDryRun || turn.site.aiMode === "OFF" || turn.order?.aiDisabled) return;
    if (turn.order?.deliveryStatus === "DELIVERED" || turn.order?.orderStatus === "CANCELLED") return;

    // Человек уже написал этому номеру после входящего — руками, из карточки или из QUO.
    const phone = turn.communication.externalPhoneNormalized;
    const manual = await prisma.orderCommunication.findFirst({
      where: {
        direction: "OUTBOUND",
        externalPhoneNormalized: phone,
        occurredAt: { gt: turn.createdAt },
        status: { notIn: ["FAILED"] },
        ...(turn.orderId ? { orderId: turn.orderId } : { storePhone: turn.communication.storePhone }),
      },
      select: { id: true },
    });
    if (manual) return;

    const target = turn.order ? pickOrderTarget(phone, turn.communication.partyRole, turn.order) : null;
    if (target) {
      await sendOrderSms(prisma, quoClient(), { orderId: turn.orderId!, target, text: NUDGE_TEXT, idempotencyKey: `ai-nudge:${turn.id}` });
      return;
    }
    await sendUnlinkedSms(prisma, quoClient(), {
      siteId: turn.siteId, toPhone: phone, text: NUDGE_TEXT, idempotencyKey: `ai-nudge:${turn.id}`, orderId: turn.orderId,
    });
  };
}
