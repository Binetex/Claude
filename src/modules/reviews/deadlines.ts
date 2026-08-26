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

export type DeadlineSweep = { checked: number; moved: number; reminded: number };

const BATCH = 50;

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
