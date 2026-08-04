import "server-only";
import type { PrismaClient } from "@/generated/prisma/client";
import type { OutboxHandler } from "@/outbox/worker";
import type { OutboxRecord } from "@/outbox/types";
import { getTelegramEvent } from "./registry";
import { resolveOwnerBot, resolveFloristBot, resolveBotById, type BotLookup, type ResolvedBot } from "./bots";
import { isTelegramGloballyEnabled } from "./config";
import { TelegramSender } from "./sender";
import {
  buttonsFor,
  renderFloristMessage,
  renderFloristHandedOver,
  renderOwnerCreated,
  renderOwnerDeliveryProblem,
  renderOwnerNoCouriers,
  renderOwnerPaymentProblem,
  renderOwnerPendingTooLong,
  renderOwnerStatusMismatch,
  renderOwnerPaymentNotFound,
  type OrderSnapshot,
} from "./templates";
import { getOrderItemImages } from "@/modules/orders/images";
import type { TelegramAudience } from "./config";
import type { TelegramNotifyPayload } from "./events";

/**
 * Единый обработчик ВСЕХ внутренних Telegram-уведомлений: тип события → запись реестра →
 * бот → текст → отправка или редактирование. Новый тип не требует нового обработчика.
 *
 * Ключевое отличие от общего бота: сообщение редактируется ТЕМ ЖЕ ботом, который его отправил
 * (Telegram не позволяет иначе). Поэтому TelegramMessage хранит botId, и при редактировании
 * берётся токен именно этого бота, а не текущий бот флориста.
 *
 * Гарантии:
 *  - глобальный выключатель — штатный no-op;
 *  - у флориста нет бота / бот выключен → тихий пропуск (решение владельца);
 *  - настройка сломана (не расшифровывается токен) → throw, чтобы это стало видно;
 *  - временная ошибка Telegram → throw, outbox повторит с backoff;
 *  - текст не изменился → в Telegram не ходим вовсе;
 *  - сообщение удалено → отправляем новое и обновляем messageId.
 */
export function buildTelegramNotifyHandler(prisma: PrismaClient): OutboxHandler {
  return async (record: OutboxRecord) => {
    const p = record.payload as TelegramNotifyPayload;
    if (!p?.type || !p?.orderId) return;

    const def = getTelegramEvent(p.type);
    if (!def) {
      console.warn(`[telegram] неизвестный тип события ${p.type} — пропуск`);
      return;
    }

    if (!(await isTelegramGloballyEnabled(prisma))) {
      console.info(`[telegram] ${p.type} пропущено: уведомления выключены`);
      return;
    }

    if (def.perFlorist && !p.floristId) {
      console.warn(`[telegram] ${p.type} без floristId — пропуск`);
      return;
    }

    const order = await loadOrderSnapshot(prisma, p.orderId);
    if (!order) return; // заказ исчез — уведомлять не о чем

    const ctx = p.context ?? {};
    const dedupeKey = def.dedupeKey({ orderId: order.id, floristId: p.floristId });
    const existing = await prisma.telegramMessage.findUnique({ where: { dedupeKey } });

    // Редактировать может только отправивший бот, поэтому для существующего сообщения
    // берём именно его токен, а не текущего бота флориста (тот мог смениться).
    const lookup: BotLookup = existing?.botId
      ? await resolveBotById(prisma, existing.botId)
      : def.perFlorist
        ? await resolveFloristBot(prisma, p.floristId!)
        : await resolveOwnerBot(prisma);

    if ("skip" in lookup) {
      if (lookup.skip === "bad_token_ciphertext") {
        // Поломка настройки (сменился ключ шифрования) — терять молча нельзя.
        throw new Error(`telegram_bot_unusable:${lookup.skip}`);
      }
      console.info(`[telegram] ${p.type} пропущено: ${lookup.skip}`);
      return;
    }

    const bot: ResolvedBot = lookup.bot;
    const text = renderFor(p.type, order, ctx);
    const buttons = buttonsFor(p.type, order);
    // Фото — только у сообщений флористу. Одно фото прикрепляется к самой карточке,
    // несколько уходят альбомом отдельным сообщением ПЕРЕД ней (см. sendAlbumOnce).
    const wantPhoto = def.audience === "FLORIST" && !!order.imageUrl;
    const wantAlbum = def.audience === "FLORIST" && order.albumUrls.length > 0;
    const sender = new TelegramSender(bot.token);

    /**
     * Заказ ВЕРНУЛСЯ к флористу, у которого уже был: его прежнее сообщение помечено «передан».
     * Править его нельзя — Telegram о правках не уведомляет, а само сообщение к этому моменту
     * уехало вверх чата, и флорист просто не узнает, что заказ снова на нём. Поэтому шлём новое,
     * а прежнее оставляем как есть: оно верно описывает тогдашнюю передачу.
     */
    const returning = !!existing && p.type === "order.assigned" && existing.eventType === "order.handed_over";
    if (returning) {
      // Альбом привязан к тому же ключу — сбрасываем отметку, чтобы фото пришли с новой карточкой.
      await prisma.telegramMessage.deleteMany({ where: { dedupeKey: `${dedupeKey}:album` } });
    }

    if (existing && !returning) {
      if (existing.lastText === text) return; // нечего менять
      // Фото-сообщение и текстовое правятся разными методами и не конвертируются: выбираем по
      // тому, чем сообщение было отправлено (existing.isPhoto), а не по текущему наличию фото.
      const edited = existing.isPhoto
        ? await sender.editMessageCaption(existing.chatId, existing.messageId, text, buttons)
        : await sender.editMessage(existing.chatId, existing.messageId, text, buttons);
      if (edited.ok) {
        await prisma.telegramMessage.update({ where: { dedupeKey }, data: { lastText: text, eventType: p.type } });
        return;
      }
      if (!edited.needsResend) {
        if (edited.retryable) throw new Error(`telegram_edit_transient:${edited.code}`);
        console.error(`[telegram] edit ${p.type} order ${order.id} не удалось: ${edited.code}`);
        return;
      }
      // Сообщение удалено/нередактируемо — отправим новое вместо него.
    }

    // Альбом уходит ПЕРВЫМ, чтобы фото оказались над карточкой, а не под ней.
    if (wantAlbum) {
      await sendAlbumOnce(prisma, sender, {
        dedupeKey,
        chatId: bot.chatId,
        botId: bot.id,
        audience: def.audience,
        orderId: order.id,
        eventType: p.type,
        photos: order.albumUrls,
      });
    }

    // Пытаемся отправить с фото; если фото не отправилось (битый URL, недоступно) — откатываемся
    // на текст, чтобы уведомление всё равно дошло. Временный сбой — на повтор через outbox.
    let sent = wantPhoto ? await sender.sendPhoto(bot.chatId, order.imageUrl!, text, buttons) : await sender.sendMessage(bot.chatId, text, buttons);
    let isPhoto = wantPhoto && sent.ok;
    if (wantPhoto && !sent.ok && !sent.retryable) {
      console.warn(`[telegram] фото для заказа ${order.id} не отправлено (${sent.code}) — отправляю текстом`);
      sent = await sender.sendMessage(bot.chatId, text, buttons);
      isPhoto = false;
    }
    if (!sent.ok) {
      if (sent.retryable) throw new Error(`telegram_send_transient:${sent.code}`);
      console.error(`[telegram] send ${p.type} order ${order.id} не удалось: ${sent.code}`);
      return;
    }

    await prisma.telegramMessage.upsert({
      where: { dedupeKey },
      create: {
        dedupeKey,
        audience: def.audience,
        chatId: bot.chatId,
        messageId: sent.messageId,
        botId: bot.id,
        orderId: order.id,
        eventType: p.type,
        lastText: text,
        isPhoto,
      },
      update: { chatId: bot.chatId, messageId: sent.messageId, botId: bot.id, lastText: text, eventType: p.type, isPhoto },
    });
  };
}

/**
 * Все фото позиций заказа — ОДНИМ альбомом, отдельным сообщением перед карточкой.
 *
 * Почему альбом отдельно от текста: Telegram не разрешает inline-клавиатуру у media group
 * (`sendMediaGroup` не принимает reply_markup вовсе), а у сообщения флористу есть «Open Order»
 * и «Google Maps». Уместить фото и кнопки в одно сообщение API не даёт ни в каком виде, поэтому
 * фото идут альбомом сверху, а карточка с кнопками — текстом под ним.
 *
 * Отправляется РОВНО ОДИН РАЗ на заказ и флориста: факт фиксируется отдельной строкой
 * TelegramMessage со своим dedupeKey (схема не менялась — модель позволяет любой ключ).
 * Состав альбома Telegram править не даёт, поэтому при изменении позиций заказа он не
 * пересобирается; редактируется только карточка под ним.
 *
 * Сбой альбома НЕ роняет обработчик: карточка уходит следом в любом случае, уведомление
 * доходит без фото. Временные сбои гасит retry внутри TelegramSender.
 */
async function sendAlbumOnce(
  prisma: PrismaClient,
  sender: TelegramSender,
  args: {
    dedupeKey: string;
    chatId: string;
    botId: string;
    audience: TelegramAudience;
    orderId: string;
    eventType: string;
    photos: string[];
  }
): Promise<void> {
  const albumKey = `${args.dedupeKey}:album`;
  const already = await prisma.telegramMessage.findUnique({ where: { dedupeKey: albumKey }, select: { id: true } });
  if (already) return;

  const sent = await sender.sendMediaGroup(args.chatId, args.photos);
  if (!sent.ok) {
    console.warn(`[telegram] альбом позиций заказа ${args.orderId} не отправлен: ${sent.code}`);
    return;
  }

  try {
    await prisma.telegramMessage.create({
      data: {
        dedupeKey: albumKey,
        audience: args.audience,
        chatId: args.chatId,
        messageId: sent.messageId, // id первого сообщения группы
        botId: args.botId,
        orderId: args.orderId,
        eventType: args.eventType,
        isPhoto: true,
      },
    });
  } catch (err) {
    // Гонка двух событий по одному заказу: альбом уже зафиксирован другим проходом.
    if (!(err && typeof err === "object" && "code" in err && (err as { code?: string }).code === "P2002")) throw err;
  }
}

function renderFor(type: TelegramNotifyPayload["type"], order: OrderSnapshot, ctx: Record<string, string | null>): string {
  switch (type) {
    case "order.assigned":
      return renderFloristMessage(order, { floristName: ctx.floristName ?? null });
    case "order.handed_over":
      return renderFloristHandedOver(order, ctx.toFloristName ?? null);
    case "order.created":
      return renderOwnerCreated(order, ctx.paymentLabel ?? "—");
    case "payment.failed":
      return renderOwnerPaymentProblem(order, ctx.safeReason ?? ctx.attemptStatus ?? "платёж отклонён");
    case "payment.pending_too_long":
      return renderOwnerPendingTooLong(order, ctx.pendingMinutes ?? null, ctx.normalized ?? null);
    case "payment.status_mismatch":
      return renderOwnerStatusMismatch(order, ctx.mismatchType ?? null, ctx.normalized ?? null);
    case "payment.not_found":
      return renderOwnerPaymentNotFound(order);
    case "delivery.problem":
      return renderOwnerDeliveryProblem(order, ctx.status ?? "PROBLEM", ctx.safeReason ?? null);
    case "delivery.no_couriers":
      return renderOwnerNoCouriers(order, ctx.checkedAt ?? null);
  }
}

async function loadOrderSnapshot(prisma: PrismaClient, orderId: string): Promise<OrderSnapshot | null> {
  const o = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      id: true, orderNumber: true, deliveryDate: true, deliveryWindow: true,
      recipientName: true, addressLine: true, apartment: true, city: true, zip: true,
      cardMessage: true, deliveryInstructions: true,
      site: { select: { name: true } },
      items: { select: { name: true, variantName: true, quantity: true, floristCompositionSnapshot: true, image: true, parentImageUrl: true, variantImageUrl: true } },
    },
  });
  if (!o) return null;
  // По одному фото на позицию заказа, в порядке позиций и без повторов (две одинаковые позиции
  // не должны давать две одинаковые картинки). Первое идёт основным сообщением с подписью и
  // кнопками, остальные — альбомом следом.
  const photos = [...new Set(o.items.map((i) => getOrderItemImages(i).primary).filter((u): u is string => !!u))];
  return {
    id: o.id,
    orderNumber: o.orderNumber,
    siteName: o.site.name,
    deliveryDate: o.deliveryDate,
    deliveryWindow: o.deliveryWindow,
    recipientName: o.recipientName,
    addressLine: o.addressLine,
    apartment: o.apartment,
    city: o.city,
    zip: o.zip,
    cardMessage: o.cardMessage,
    deliveryInstructions: o.deliveryInstructions,
    // Одно фото — прикрепляем прямо к карточке (подпись + кнопки в одном сообщении).
    // Несколько — все уходят альбомом, а карточка идёт текстом под ним: клавиатуру
    // Telegram у media group не принимает, поэтому кнопки живут на текстовом сообщении.
    imageUrl: photos.length === 1 ? photos[0] : null,
    albumUrls: photos.length > 1 ? photos : [],
    items: o.items.map((i) => ({ name: i.name, variantName: i.variantName, quantity: i.quantity, composition: i.floristCompositionSnapshot })),
  };
}
