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
import { createQuoClient } from "@/integrations/quo/client";
import { sendOrderSms, sendUnlinkedSms } from "@/integrations/quo/send";
import { resolveOwnerBot, resolveFloristBot } from "@/integrations/telegram/bots";
import { TelegramSender } from "@/integrations/telegram/sender";
import { pickRecipient, storeHour } from "./routing";

export type DeliverResult = { ok: true } | { ok: false; code: string };

/** Кнопка подтверждения: одно нажатие вместо печати ответа. */
export const SEND_ACTION_PREFIX = "ai:send:";

/**
 * Отправляет готовый текст разбора клиенту. Адресат — тот, кто написал: отвечаем в тот же
 * разговор, а не «заказчику по умолчанию».
 */
export async function sendAssistantReply(prisma: PrismaClient, turnId: string, decidedByUserId?: string): Promise<DeliverResult> {
  const turn = await prisma.aiTurn.findUnique({
    where: { id: turnId },
    select: {
      id: true, status: true, replyText: true, orderId: true, siteId: true,
      site: { select: { aiDryRun: true } },
      communication: { select: { partyRole: true, externalPhoneNormalized: true } },
    },
  });
  if (!turn) return { ok: false, code: "turn_not_found" };
  // Повторное нажатие кнопки или гонка двух воркеров: отправляем только из черновика.
  if (turn.status !== "DRAFT") return { ok: false, code: "already_decided" };
  if (!turn.replyText?.trim()) return { ok: false, code: "no_text" };
  // Сухой прогон означает «наружу не уходит ничего» — включая нажатие кнопки.
  if (turn.site.aiDryRun) return { ok: false, code: "dry_run" };

  // Незнакомый номер: заказа нет, отвечаем в тот же номер от номера магазина.
  if (!turn.orderId) {
    const cfg = getQuoConfig();
    const res = await sendUnlinkedSms(prisma, cfg ? createQuoClient(cfg) : null, {
      siteId: turn.siteId,
      toPhone: turn.communication.externalPhoneNormalized,
      text: turn.replyText.trim(),
      idempotencyKey: `ai-turn:${turn.id}`,
    });
    if (!res.ok) return { ok: false, code: res.code };
    await prisma.aiTurn.update({
      where: { id: turn.id },
      data: { status: "SENT", sentCommunicationId: res.communicationId ?? null, decidedAt: new Date(), decidedByUserId: decidedByUserId ?? null },
    });
    return { ok: true };
  }

  const order = await prisma.order.findUnique({
    where: { id: turn.orderId },
    select: { senderPhone: true, recipientPhone: true },
  });
  if (!order) return { ok: false, code: "order_not_found" };

  // Кому именно: сравниваем номер входящего с номерами заказа. partyRole устаревает, когда
  // телефон в заказе правят, поэтому он — запасной вариант, а не первый.
  const incomingPhone = turn.communication.externalPhoneNormalized;
  const target =
    incomingPhone && order.recipientPhone && incomingPhone === order.recipientPhone
      ? "RECIPIENT"
      : incomingPhone && order.senderPhone && incomingPhone === order.senderPhone
        ? "CUSTOMER"
        : turn.communication.partyRole === "RECIPIENT"
          ? "RECIPIENT"
          : "CUSTOMER";

  const cfg = getQuoConfig();
  const res = await sendOrderSms(prisma, cfg ? createQuoClient(cfg) : null, {
    orderId: turn.orderId,
    target,
    text: turn.replyText.trim(),
    idempotencyKey: `ai-turn:${turn.id}`,
  });
  if (!res.ok) return { ok: false, code: res.code };

  await prisma.aiTurn.update({
    where: { id: turn.id },
    data: {
      status: "SENT",
      sentCommunicationId: res.communicationId ?? null,
      decidedAt: new Date(),
      decidedByUserId: decidedByUserId ?? null,
    },
  });
  return { ok: true };
}

/** Короткая выжимка для Telegram: длинные простыни в чате никто не читает. */
function clip(text: string, limit: number): string {
  const t = text.trim().replace(/\s+/g, " ");
  return t.length > limit ? `${t.slice(0, limit - 1)}…` : t;
}

/**
 * Показывает черновик тому, кто сейчас отвечает: до полудня владельцу, после — флористу заказа.
 * Возвращает false, если показать некому (бот не настроен) — тогда черновик остаётся только в
 * карточке заказа.
 */
export async function notifyDraft(prisma: PrismaClient, turnId: string, now = new Date()): Promise<boolean> {
  const turn = await prisma.aiTurn.findUnique({
    where: { id: turnId },
    select: {
      id: true, replyText: true, important: true, needsHuman: true, intent: true,
      site: { select: { name: true, timezone: true } },
      order: { select: { orderNumber: true, currentFloristId: true, site: { select: { timezone: true } } } },
      communication: { select: { messageText: true, transcript: true, externalPhone: true } },
    },
  });
  if (!turn) return false;

  // Незнакомый номер идёт только владельцу: флориста у разговора без заказа нет.
  const who = turn.order
    ? pickRecipient({ storeHour: storeHour(turn.order.site?.timezone, now), hasFlorist: !!turn.order.currentFloristId })
    : "OWNER";
  const lookup =
    who === "FLORIST" && turn.order?.currentFloristId
      ? await resolveFloristBot(prisma, turn.order.currentFloristId)
      : await resolveOwnerBot(prisma);
  if (!("bot" in lookup)) return false;

  const incoming = clip(turn.communication.messageText ?? turn.communication.transcript ?? "", 400);
  const draft = turn.replyText?.trim();
  const head = turn.important ? "❗ Важное сообщение от клиента" : "Сообщение от клиента";
  const where = turn.order
    ? `заказ ${turn.order.orderNumber}`
    : `незнакомый номер ${turn.communication.externalPhone} · ${turn.site.name}`;
  const lines = [
    `<b>${head}</b> · ${where}`,
    "",
    `Клиент: ${incoming}`,
    "",
    draft ? `Ответ ассистента:\n${draft}` : "Ассистент не смог ответить — нужен человек.",
    "",
    draft ? "Нажмите «Отправить» или ответьте на это сообщение своим текстом." : "Ответьте на это сообщение своим текстом.",
  ];

  const sender = new TelegramSender(lookup.bot.token);
  const res = await sender.sendMessage(
    lookup.bot.chatId,
    lines.join("\n"),
    draft ? [{ text: "Отправить", callbackData: `${SEND_ACTION_PREFIX}${turn.id}` }] : undefined
  );
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
        .sendMessage(owner.bot.chatId, `<b>❗ Важное от клиента</b> · заказ ${turn.order.orderNumber}\n\n${incoming}\n\nЧерновик ответа ушёл флористу.`)
        .catch(() => null);
    }
  }
  return true;
}

/** Нейтральный текст, когда человек не успел ответить. Один раз и коротко. */
export const NUDGE_TEXT = "One moment — we are checking on this and will get right back to you.";

/**
 * Клиент написал, черновик ждёт человека, а человек занят. Через двадцать минут отправляем одно
 * нейтральное сообщение: молчание магазина читается хуже, чем «сейчас посмотрим».
 *
 * Сам черновик при этом остаётся черновиком: настоящий ответ всё ещё за человеком.
 */
export function buildAssistantNudgeHandler(prisma: PrismaClient) {
  return async (record: { payload: unknown }): Promise<void> => {
    const p = record.payload as { turnId?: string };
    if (!p?.turnId) return;

    const turn = await prisma.aiTurn.findUnique({
      where: { id: p.turnId },
      select: {
        id: true, status: true, orderId: true, siteId: true,
        site: { select: { aiDryRun: true } },
        communication: { select: { partyRole: true, externalPhoneNormalized: true } },
        order: { select: { senderPhone: true, recipientPhone: true, orderStatus: true, deliveryStatus: true } },
      },
    });
    // Ответили, отказались или сухой прогон — говорить «одну минуту» уже незачем.
    if (!turn || turn.status !== "DRAFT" || turn.site.aiDryRun) return;
    if (!turn.orderId || !turn.order) {
      const cfg = getQuoConfig();
      await sendUnlinkedSms(prisma, cfg ? createQuoClient(cfg) : null, {
        siteId: turn.siteId, toPhone: turn.communication.externalPhoneNormalized, text: NUDGE_TEXT, idempotencyKey: `ai-nudge:${turn.id}`,
      });
      return;
    }
    if (turn.order.deliveryStatus === "DELIVERED") return;

    const incomingPhone = turn.communication.externalPhoneNormalized;
    const target =
      incomingPhone && turn.order.recipientPhone && incomingPhone === turn.order.recipientPhone
        ? "RECIPIENT"
        : turn.communication.partyRole === "RECIPIENT" && !incomingPhone
          ? "RECIPIENT"
          : "CUSTOMER";

    const cfg = getQuoConfig();
    await sendOrderSms(prisma, cfg ? createQuoClient(cfg) : null, {
      orderId: turn.orderId,
      target,
      text: NUDGE_TEXT,
      idempotencyKey: `ai-nudge:${turn.id}`,
    });
  };
}
