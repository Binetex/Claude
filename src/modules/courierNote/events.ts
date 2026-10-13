import "server-only";
/**
 * «Пересобери инструкцию курьеру» — задача воркеру.
 *
 * Отдельной задачей, а не прямо на месте: разбор ходит в модель и ждёт секунды, а приём заказа,
 * приём SMS и сохранение заметки обязаны оставаться быстрыми и не падать из-за чужой
 * недоступности. Обработчик всегда читает СВЕЖИЕ данные заказа, поэтому повод в задаче — только
 * ключ дедупа, а не содержимое.
 */
import { createHash } from "node:crypto";
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { PrismaOutboxRepository } from "@/outbox/prismaRepository";

export const COURIER_NOTE_EVENT = "courier.note.refresh";

export type CourierNotePayload = { orderId: string; communicationId?: string };

/**
 * Пауза после SMS — та же минута, что у ассистента: люди пишут очередями («код 1408», через
 * двадцать секунд «квартира 3»), и разбор после паузы видит всю очередь.
 */
export const COURIER_NOTE_SMS_DELAY_SEC = 60;

export type CourierNoteTrigger =
  /** Появился или изменился текст заказа: инструкции с сайта, заметка команды. Ключ — сам текст. */
  | { kind: "text"; text: string }
  /** Входящее SMS клиента по заказу. */
  | { kind: "message"; communicationId: string };

/**
 * Ключ включает повод: одно SMS — один разбор, один и тот же текст заказа — один разбор (повторный
 * вебхук Shopify с теми же инструкциями второго не создаст). Никогда не бросает: инструкция
 * курьеру не имеет права ронять приём заказа или сохранение карточки.
 */
export async function requestCourierNote(prisma: PrismaClient, orderId: string, trigger: CourierNoteTrigger): Promise<void> {
  try {
    if (trigger.kind === "text" && !trigger.text.trim()) return;
    const key =
      trigger.kind === "message"
        ? `msg:${trigger.communicationId}`
        : `text:${courierNoteHash(trigger.text)}`;
    const delaySec = trigger.kind === "message" ? COURIER_NOTE_SMS_DELAY_SEC : 0;
    await new PrismaOutboxRepository(prisma).enqueue({
      eventType: COURIER_NOTE_EVENT,
      aggregateType: "order",
      aggregateId: orderId,
      payload: {
        orderId,
        ...(trigger.kind === "message" ? { communicationId: trigger.communicationId } : {}),
      } satisfies CourierNotePayload,
      idempotencyKey: `courier-note:${orderId}:${key}`,
      availableAt: new Date(Date.now() + delaySec * 1000),
    });
  } catch (err) {
    console.error(`[courier-note] задача для заказа ${orderId} не поставлена:`, err instanceof Error ? err.message : String(err));
  }
}

/**
 * Новый заказ: покупатель мог написать курьеру при оформлении (Shopify — поле инструкций, Woo —
 * заметка заказа). Ключ — тот же текст, что даёт повторный вебхук Shopify с теми же инструкциями,
 * поэтому второго разбора он не создаст.
 */
export async function requestCourierNoteForNewOrder(prisma: PrismaClient, orderId: string): Promise<void> {
  const o = await prisma.order
    .findUnique({ where: { id: orderId }, select: { deliveryInstructions: true, customerNote: true } })
    .catch(() => null);
  if (!o) return;
  const text = [o.deliveryInstructions, o.customerNote].map((t) => t.trim()).filter(Boolean).join("\n");
  await requestCourierNote(prisma, orderId, { kind: "text", text });
}

/**
 * «Довези инструкцию до Burq» — отдельной задачей, поставленной В ОДНОЙ ТРАНЗАКЦИИ с записью
 * инструкции. Иначе падение воркера между записью и Burq теряло бы отправку навсегда: повторный
 * разбор видит, что инструкция уже такая, и ничего не делает. Все отправки идут через очередь
 * одного воркера — две правки подряд не пересоздают черновик наперегонки.
 */
export const COURIER_NOTE_PUSH_EVENT = "courier.note.push";

export type CourierNotePushPayload = {
  orderId: string;
  /** Какой текст отправить. Инструкцию успели поменять ещё раз — у новой своя задача, эта пропускается. */
  noteHash: string;
  /** Не дошла до курьера — сказать владельцу и флористу. Человеку, правившему карточку, не нужно: он видит предупреждение. */
  notify: boolean;
};

export function courierNoteHash(note: string): string {
  return createHash("sha1").update(note.trim()).digest("hex").slice(0, 16);
}

/** `key` уникален сам по себе (id задачи разбора или момент правки): в транзакции повтор ключа её оборвал бы. */
export async function enqueueCourierNotePush(
  db: PrismaClient | Prisma.TransactionClient,
  input: { orderId: string; note: string; notify: boolean; key: string }
): Promise<void> {
  await new PrismaOutboxRepository(db).enqueue({
    eventType: COURIER_NOTE_PUSH_EVENT,
    aggregateType: "order",
    aggregateId: input.orderId,
    payload: { orderId: input.orderId, noteHash: courierNoteHash(input.note), notify: input.notify } satisfies CourierNotePushPayload,
    idempotencyKey: `courier-note-push:${input.orderId}:${input.key}`,
  });
}
