import "server-only";
/**
 * Воркер: собрать инструкцию курьеру из слов клиента и команды и довезти её до Burq.
 *
 * Поводы (`events.ts::requestCourierNote`): приём заказа с инструкциями с сайта, входящее SMS
 * клиента, правка заметки командой. Каждый раз читаются ВСЕ источники заново — инструкция
 * выводится из них, а не накапливается из поводов.
 *
 * Что может пойти не так и что тогда:
 *  - модель недоступна — один повтор очередью (временная ошибка) или молча (ключ, баланс):
 *    старая инструкция остаётся как была;
 *  - ответ не прошёл проверку (кириллица, выдуманное число, длина) — поле не трогаем;
 *  - пока шёл запрос, инструкцию поправили — повтор очередью уже со свежими данными.
 * Записанная инструкция довозится до Burq отдельной задачей (`buildCourierNotePushHandler`),
 * поставленной в той же транзакции: курьер уже вызван или черновик не пересоздать — владельцу и
 * флористу в Telegram, передайте сами.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import type { OutboxHandler } from "@/outbox/worker";
import type { OutboxRecord } from "@/outbox/types";
import { resolveDeepseekConfig } from "@/integrations/deepseek/settings";
import { createDeepseekClient, type DeepseekClient, type DeepseekMessage } from "@/integrations/deepseek/client";
import { DeepseekError } from "@/integrations/deepseek/errors";
import { commGroupOf } from "@/integrations/quo/communicationsView";
import { COURIER_NOTE_NEEDS_PEOPLE, pushCourierNoteToBurq } from "@/integrations/delivery/burq/courierNoteBurq";
import { publishTelegramNotification } from "@/integrations/telegram/events";
import { COURIER_NOTE_MAX } from "@/lib/courierNote";
import { TERMINAL_ORDER_STATUSES } from "@/lib/statuses";
import { todayStrInTz } from "@/lib/tz";
import { isTapback, isThanks } from "@/modules/assistant/policy";
import {
  AI_NOTE_MAX,
  buildCourierNoteMessages,
  nextCourierNote,
  retryAfterRejection,
  teamNoteForCourier,
  validateCourierNote,
  type CourierNoteMessage,
  type CourierNoteVerdict,
} from "./extract";
import { courierNoteEditedByHuman } from "./view";
import { courierNoteHash, enqueueCourierNotePush, type CourierNotePayload, type CourierNotePushPayload } from "./events";

/** Дописка к инструкции человека короче: его текст уже занимает место. */
const HUMAN_ADDITION_MAX = 120;
/** Сколько последних SMS по заказу видит модель. */
const MESSAGES_LIMIT = 20;

function log(orderNumber: string, msg: string): void {
  console.log(`[courier-note] ${orderNumber}: ${msg}`);
}

export function buildCourierNoteHandler(
  prisma: PrismaClient,
  /** Модель подменяется в тестах; в воркере — из настроек ассистента. */
  deps: { client?: DeepseekClient } = {}
): OutboxHandler {
  return async (record: OutboxRecord) => {
    const p = record.payload as CourierNotePayload;
    if (!p?.orderId) return;
    const order = await prisma.order.findUnique({
      where: { id: p.orderId },
      select: {
        id: true, orderNumber: true, orderStatus: true, deliveryDate: true, currentFloristId: true,
        deliveryInstructions: true, customerNote: true, courierNote: true,
        addressLine: true, apartment: true, senderPhone: true, recipientPhone: true,
        site: { select: { timezone: true } },
      },
    });
    if (!order || TERMINAL_ORDER_STATUSES.includes(order.orderStatus)) return;
    // Прошедший день — курьер уже съездил. `deliveryDate` — UTC-полночь местного дня.
    if (order.deliveryDate.toISOString().slice(0, 10) < todayStrInTz(order.site.timezone)) return;

    // Повод — SMS: только настоящее входящее с текстом по этому заказу.
    if (p.communicationId) {
      const c = await prisma.orderCommunication.findUnique({
        where: { id: p.communicationId },
        select: { orderId: true, direction: true, messageText: true },
      });
      if (!c || c.orderId !== order.id || c.direction !== "INBOUND" || !c.messageText?.trim()) return;
      // «Thank you!», «Received» и лайки iPhone нового для курьера не несут — модель не зовём.
      if (isThanks(c.messageText) || isTapback(c.messageText)) return;
    }

    const comms = await prisma.orderCommunication.findMany({
      where: { orderId: order.id, type: "SMS", messageText: { not: null }, status: { not: "FAILED" } },
      orderBy: { occurredAt: "desc" },
      take: MESSAGES_LIMIT,
      select: { direction: true, messageText: true, externalPhone: true, partyRole: true },
    });
    const messages = comms.reverse().flatMap((c): CourierNoteMessage[] => {
      const text = c.messageText?.trim();
      if (!text) return [];
      if (c.direction === "OUTBOUND") return [{ from: "shop", text }];
      const side = commGroupOf(c, order.senderPhone, order.recipientPhone);
      return [{ from: side === "RECIPIENT" ? "recipient" : side === "CUSTOMER" ? "customer" : "client", text }];
    });
    const clientTexts = messages.filter((m) => m.from !== "shop").map((m) => m.text);
    // Русские пометки команды курьеру не предназначены и модели не показываются вовсе.
    const teamNote = teamNoteForCourier(order.customerNote);
    if (!order.deliveryInstructions.trim() && !teamNote && clientTexts.length === 0) return;

    const cfg = deps.client ? null : await resolveDeepseekConfig(prisma);
    const client = deps.client ?? (cfg ? createDeepseekClient(cfg) : null);
    if (!client) return; // ключа модели нет — ассистент так же молчит, это не ошибка

    const byHuman = await courierNoteEditedByHuman(prisma, order.id);
    // Человек стёр инструкцию — это его решение «курьеру ничего», а не приглашение написать заново.
    if (byHuman && !order.courierNote.trim()) return;
    const input = {
      checkoutInstructions: order.deliveryInstructions,
      teamNote,
      messages,
      addressLine: order.addressLine,
      apartment: order.apartment,
      current: order.courierNote,
      currentByHuman: byHuman,
    };

    // Числа ответа сверяются только со словами клиента и команды: наши же SMS (номер заказа,
    // окно доставки) не дают модели права вписать их курьеру.
    const sources = [order.deliveryInstructions, teamNote, ...clientTexts, order.addressLine, order.apartment ?? "", order.courierNote].join("\n");
    const max = byHuman ? HUMAN_ADDITION_MAX : AI_NOTE_MAX;
    const prompt: DeepseekMessage[] = buildCourierNoteMessages(input);

    let verdict: CourierNoteVerdict;
    try {
      const first = (await client.complete(prompt, { temperature: 0 })).text;
      verdict = validateCourierNote(first, sources, max);
      // Одна вторая попытка с объяснением: иначе лишняя цифра стоила бы всей инструкции.
      if (!verdict.ok) {
        log(order.orderNumber, `ответ модели отклонён: ${verdict.reason}, спрашиваем ещё раз`);
        const retry = [...prompt, { role: "assistant" as const, content: first }, { role: "user" as const, content: retryAfterRejection(verdict.reason) }];
        verdict = validateCourierNote((await client.complete(retry, { temperature: 0 })).text, sources, max);
      }
    } catch (err) {
      // Временная ошибка — ОДИН повтор очередью позже, не восемь: каждая попытка держит воркер до
      // сорока секунд, а за ним в очереди стоят SMS, Telegram и черновики Burq. Ключ или баланс
      // сами не починятся: молчим, о пустом балансе владелец узнаёт от ассистента.
      if (err instanceof DeepseekError && err.retryable && record.attempts < 2) throw err;
      log(order.orderNumber, `модель не ответила: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (!verdict.ok) {
      log(order.orderNumber, `ответ модели отклонён повторно: ${verdict.reason} — инструкцию не трогаем`);
      return;
    }

    const next = nextCourierNote(order.courierNote, byHuman, verdict.note, COURIER_NOTE_MAX);
    if (next == null) return;

    // Пишем, только если инструкцию не поменяли, пока шёл запрос: правка человека главнее. В той
    // же транзакции — задача довезти текст до Burq: запись прошла, значит и отправка случится.
    const written = await prisma.$transaction(async (tx) => {
      const res = await tx.order.updateMany({ where: { id: order.id, courierNote: order.courierNote }, data: { courierNote: next } });
      if (res.count === 0) return false;
      await enqueueCourierNotePush(tx, { orderId: order.id, note: next, notify: true, key: record.id });
      return true;
    });
    if (!written) throw new Error("инструкцию курьеру изменили во время разбора — повторим со свежими данными");
    log(order.orderNumber, `${byHuman ? "дописано" : "записано"} ${next.length} зн.`);
  };
}

/**
 * Довезти инструкцию до Burq. Текст берётся из заказа; если его успели поменять ещё раз, у нового
 * своя задача — эта пропускается, чтобы не пересоздавать черновик дважды.
 */
export function buildCourierNotePushHandler(prisma: PrismaClient): OutboxHandler {
  return async (record: OutboxRecord) => {
    const p = record.payload as CourierNotePushPayload;
    if (!p?.orderId) return;
    const order = await prisma.order.findUnique({ where: { id: p.orderId }, select: { orderNumber: true, courierNote: true, currentFloristId: true } });
    if (!order || courierNoteHash(order.courierNote) !== p.noteHash) return;

    // Задача поставлена в одной транзакции с записью инструкции: её createdAt — момент записи.
    const burq = await pushCourierNoteToBurq(prisma, p.orderId, record.createdAt);
    log(order.orderNumber, `Burq: ${burq}`);
    if (!p.notify || !order.courierNote.trim() || !COURIER_NOTE_NEEDS_PEOPLE.includes(burq)) return;

    // Ключ — сам текст: та же инструкция второго сообщения не даст, новая — даст.
    const occurrence = `${p.orderId}:${p.noteHash}`;
    const context = { note: order.courierNote, reason: burq };
    await publishTelegramNotification(prisma, { type: "delivery.courier_note", orderId: p.orderId, occurrenceKey: occurrence, context });
    if (order.currentFloristId) {
      await publishTelegramNotification(prisma, {
        type: "delivery.courier_note_florist", orderId: p.orderId, floristId: order.currentFloristId, occurrenceKey: occurrence, context,
      });
    }
  };
}
