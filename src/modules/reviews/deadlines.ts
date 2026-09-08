import "server-only";
/**
 * Сроки воронки: клиент обещал оставить отзыв и пропал.
 *
 * Через `promiseWaitDays` после обещания запрос уходит в «обещал и забыл», и клиенту уходит
 * одно напоминание. Одно — второе превращается в назойливость, поэтому повтор отсекается самим
 * статусом: из FORGOT запрос сюда больше не попадает.
 *
 * Проход идёт по `nextActionAt`, тому же полю, по которому строится очередь оператора. Второго
 * места, где хранится «когда вернуться», нет и быть не должно.
 *
 * Напоминание отправляется ПОСЛЕ смены статуса: сбой отправки не должен приводить к тому, что
 * та же строка попадёт в следующий проход и клиент получит напоминание дважды. Неудача видна в
 * журнале запроса отдельной записью.
 */
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@/generated/prisma/client";
import { sendReviewLinkAndRecord } from "./sendLink";
import { recordCustomerReply } from "./requests";
import { toE164 } from "@/lib/phone";

export type DeadlineSweep = { checked: number; moved: number; reminded: number };

const BATCH = 50;

/**
 * Через сколько молчания клиент считается игнорирующим. Сутки — «на следующий день, и от него
 * ничего»: раньше этого человек просто не успел ответить, а не отказался.
 */
export const IGNORE_AFTER_HOURS = 24;

export type IgnoreSweep = { checked: number; moved: number; replied: number };

/**
 * Ссылка у клиента больше суток, и от него ни слова → «игнорирует».
 *
 * Зачем отдельный статус: после звонка и SMS запрос висел «ждём клиента» бесконечно, и по списку
 * нельзя было отличить «отправили час назад» от «молчит третий день». Владелец справедливо
 * спрашивал, какой статус тут вообще ставить.
 *
 * Молчание проверяется по ВХОДЯЩИМ этого заказа, а не по нашим отправкам: единственный признак
 * «клиент отреагировал» — это его сообщение или звонок. Ответ, пришедший позже, вернёт запрос в
 * работу обычным путём (`recordCustomerReply`), поэтому «игнорирует» не приговор, а состояние.
 */
export async function processIgnoredRequests(db: PrismaClient, now = new Date()): Promise<IgnoreSweep> {
  const since = new Date(now.getTime() - IGNORE_AFTER_HOURS * 3_600_000);
  const due = await db.orderReviewRequest.findMany({
    where: { status: "LINK_SENT", linkSentAt: { lte: since } },
    select: { id: true, linkSentAt: true, order: { select: { senderPhone: true } } },
    take: BATCH,
    orderBy: { linkSentAt: "asc" },
  });
  if (due.length === 0) return { checked: 0, moved: 0, replied: 0 };

  let moved = 0;
  let replied = 0;

  for (const r of due) {
    // Ответ ищем ПО НОМЕРУ ЗАКАЗЧИКА, а не по заказу: приём привязывает входящее к заказу с
    // ближайшей доставкой, и ответ постоянного клиента по старому заказу оказался бы у нового —
    // или ни у какого. По заказу мы бы такого клиента объявили молчащим. Тот же источник, что
    // у строки «клиент ответил» в очереди.
    const phone = toE164(r.order.senderPhone);
    const answer = phone
      ? await db.orderCommunication.findFirst({
          where: {
            externalPhoneNormalized: phone,
            direction: "INBOUND",
            occurredAt: { gt: r.linkSentAt ?? since },
          },
          orderBy: { occurredAt: "desc" },
          select: { occurredAt: true },
        })
      : null;

    // Клиент отвечал, а мы этого не заметили — возвращаем запрос человеку тем же переходом, что
    // и приём входящего. Оставить его в LINK_SENT нельзя: строка попадала бы в КАЖДЫЙ проход,
    // и партия из пятидесяти намертво закрывала бы дорогу остальным.
    if (answer) {
      if (await recordCustomerReply(db, r.id, answer.occurredAt)) replied += 1;
      continue;
    }

    const claimed = await db.orderReviewRequest.updateMany({
      where: { id: r.id, status: "LINK_SENT" },
      data: { status: "IGNORING" },
    });
    if (claimed.count === 0) continue;
    moved += 1;
    await db.reviewRequestEvent.create({ data: { requestId: r.id, kind: "IGNORED", detailSafe: "deadline" } });
  }

  return { checked: due.length, moved, replied };
}

export async function processPromisedDeadlines(db: PrismaClient, now = new Date()): Promise<DeadlineSweep> {
  const due = await db.orderReviewRequest.findMany({
    where: { status: "PROMISED", nextActionAt: { lte: now } },
    select: { id: true },
    take: BATCH,
    orderBy: { nextActionAt: "asc" },
  });
  if (due.length === 0) return { checked: 0, moved: 0, reminded: 0 };

  let moved = 0;
  let reminded = 0;

  for (const { id } of due) {
    // Условие в UPDATE, а не только в выборке: два прохода могли бы взять одну строку, и
    // клиент получил бы два напоминания подряд. Кто первый сменил статус — тот и напоминает.
    const claimed = await db.orderReviewRequest.updateMany({
      where: { id, status: "PROMISED" },
      data: { status: "FORGOT", remindedAt: now, nextActionAt: null },
    });
    if (claimed.count === 0) continue;
    moved += 1;

    await db.reviewRequestEvent.create({ data: { requestId: id, kind: "REMINDED", detailSafe: "deadline" } });

    const sent = await sendReviewLinkAndRecord(db, {
      requestId: id,
      kind: "REMINDER",
      sendKey: `review-reminder-${id}-${randomUUID()}`,
      actor: null,
    });
    if (sent.ok) reminded += 1;
  }

  return { checked: due.length, moved, reminded };
}
