import "server-only";
/**
 * Очередь оператора: что показывать на экране «Отзывы» колл-центра.
 *
 * Списки строятся ПО СРОКУ, а не по статусу. «Сегодня» — это не какой-то один статус, а всё,
 * чей срок наступил: новый запрос, недозвон вчерашний и просроченный позавчерашний. Разложить
 * то же самое по статусам значило бы держать «когда вернуться» в двух местах сразу.
 */
import { prisma } from "@/lib/db";
import type { ReviewRequestStatus } from "@/generated/prisma/client";

/**
 * Статусы, где ход за ОПЕРАТОРОМ. Только они попадают в «сегодня».
 *
 * У «обещал оставить» тоже есть срок, но он принадлежит автоматике напоминания, а не звонку:
 * без этого разделения оператор звонил бы человеку, которому через час и так уйдёт
 * напоминание, а один и тот же запрос висел бы разом в «сегодня» и в «ждут ответа».
 */
const OPERATOR_TURN: ReviewRequestStatus[] = ["NEW", "CALLING"];

const CARD = {
  id: true,
  status: true,
  callAttempts: true,
  nextActionAt: true,
  linkSentAt: true,
  linkChannel: true,
  promisedAt: true,
  remindedAt: true,
  reviewUrlSnapshot: true,
  location: { select: { id: true, name: true } },
  order: {
    select: {
      id: true,
      orderNumber: true,
      senderName: true,
      senderPhone: true,
      senderEmail: true,
      deliveryDate: true,
      site: { select: { id: true, name: true } },
      items: { select: { name: true, quantity: true } },
    },
  },
} as const;

export type QueueCard = Awaited<ReturnType<typeof listToday>>[number];

/**
 * «Сегодня» — срок наступил. Просроченные вчерашние тоже здесь: срок в прошлом означает, что к
 * запросу давно пора вернуться, а не что он выбыл.
 */
export async function listToday(now = new Date()) {
  return prisma.orderReviewRequest.findMany({
    where: { status: { in: OPERATOR_TURN }, nextActionAt: { lte: endOfDay(now) } },
    select: CARD,
    orderBy: [{ nextActionAt: "asc" }],
  });
}

/** «Ждут ответа» — ход за клиентом: ссылка у него либо он обещал. */
export async function listWaiting() {
  return prisma.orderReviewRequest.findMany({
    where: { status: { in: ["LINK_SENT", "PROMISED", "FORGOT"] } },
    select: CARD,
    orderBy: [{ linkSentAt: "desc" }],
  });
}

/** «На проверке» — клиент сказал, что оставил; нужно засчитать или вернуть в работу. */
export async function listToCheck() {
  return prisma.orderReviewRequest.findMany({
    where: { status: "READY_TO_CHECK" },
    select: CARD,
    orderBy: [{ updatedAt: "desc" }],
  });
}

export async function listClosed(limit = 50) {
  return prisma.orderReviewRequest.findMany({
    where: { status: { in: ["CONFIRMED", "DECLINED", "GAVE_UP"] } },
    select: CARD,
    orderBy: [{ closedAt: "desc" }],
    take: limit,
  });
}

export async function queueCounts(now = new Date()) {
  const [today, waiting, toCheck] = await Promise.all([
    prisma.orderReviewRequest.count({ where: { status: { in: OPERATOR_TURN }, nextActionAt: { lte: endOfDay(now) } } }),
    prisma.orderReviewRequest.count({ where: { status: { in: ["LINK_SENT", "PROMISED", "FORGOT"] } } }),
    prisma.orderReviewRequest.count({ where: { status: "READY_TO_CHECK" } }),
  ]);
  return { today, waiting, toCheck };
}

/**
 * Конец текущих суток. Берём именно конец дня, а не «сейчас»: запрос, назначенный на сегодня
 * на 18:00, оператор должен видеть с утра, а не ждать вечера.
 */
function endOfDay(now: Date): Date {
  const d = new Date(now);
  d.setHours(23, 59, 59, 999);
  return d;
}
