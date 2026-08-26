"use server";
/**
 * Работа оператора с очередью отзывов.
 *
 * Доступ — колл-центр И владелец: владелец должен уметь закрыть или засчитать запрос сам, не
 * дожидаясь оператора. Флорист сюда не ходит вовсе.
 *
 * Вся логика переходов — в modules/reviews; здесь права, ключ идемпотентности и обновление
 * страницы.
 */
import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/rbac";
import { prisma } from "@/lib/db";
import {
  recordNoAnswer,
  recordTalked,
  recordPromised,
  recordClaimed,
  confirmReview,
  declineReview,
  giveUpReview,
  reopenReview,
  changeRequestLocation,
} from "@/modules/reviews/requests";
import { sendReviewLinkAndRecord } from "@/modules/reviews/sendLink";

const PATH = "/dashboard/cc/reviews";

export type ReviewActionResult = { ok?: true; message?: string; error?: string };

/** Оператор и владелец — да, флорист — нет. */
async function requireOperator() {
  const user = await requireUser();
  if (user.role === "FLORIST") throw new Error("forbidden");
  return user;
}

function refresh() {
  revalidatePath(PATH);
  revalidatePath("/dashboard/reviews");
}

export async function noAnswerAction(requestId: string): Promise<ReviewActionResult> {
  const user = await requireOperator();
  const res = await recordNoAnswer(prisma, requestId, { userId: user.id });
  refresh();

  // Попытки исчерпаны — ссылку отправляем сами, не дожидаясь ещё одного захода оператора.
  // Это решение владельца: «две попытки — дальше пишем SMS».
  if (res.exhausted) {
    const sent = await sendReviewLinkAndRecord(prisma, {
      requestId,
      kind: "ASK",
      sendKey: `review-ask-${requestId}-${randomUUID()}`,
      actor: { userId: user.id },
    });
    refresh();
    return sent.ok
      ? { ok: true, message: `Попытки исчерпаны — ссылка отправлена (${sent.channel === "SMS" ? "SMS" : "письмо"}).` }
      : { ok: true, message: `Попытки исчерпаны, но ссылка не ушла: ${sent.error}` };
  }
  return { ok: true, message: "Записано. Вернём в очередь на следующий день." };
}

export async function talkedAction(requestId: string): Promise<ReviewActionResult> {
  const user = await requireOperator();
  await recordTalked(prisma, requestId, { userId: user.id });
  refresh();
  return { ok: true };
}

export async function promisedAction(requestId: string): Promise<ReviewActionResult> {
  const user = await requireOperator();
  await recordPromised(prisma, requestId, { userId: user.id });
  refresh();
  return { ok: true, message: "Ждём отзыв. Если не появится — напомним сами." };
}

export async function claimedAction(requestId: string): Promise<ReviewActionResult> {
  const user = await requireOperator();
  await recordClaimed(prisma, requestId, { userId: user.id });
  refresh();
  return { ok: true };
}

export async function confirmAction(requestId: string): Promise<ReviewActionResult> {
  const user = await requireOperator();
  // Вручную — значит по слову клиента. В статистике это отличается от найденного в Google.
  await confirmReview(prisma, requestId, "MANUAL", { userId: user.id });
  refresh();
  return { ok: true };
}

export async function declineAction(requestId: string): Promise<ReviewActionResult> {
  const user = await requireOperator();
  await declineReview(prisma, requestId, { userId: user.id });
  refresh();
  return { ok: true };
}

export async function giveUpAction(requestId: string): Promise<ReviewActionResult> {
  const user = await requireOperator();
  await giveUpReview(prisma, requestId, { userId: user.id });
  refresh();
  return { ok: true };
}

export async function reopenAction(requestId: string): Promise<ReviewActionResult> {
  const user = await requireOperator();
  await reopenReview(prisma, requestId, { userId: user.id });
  refresh();
  return { ok: true };
}

/**
 * Отправить ссылку вручную. Ключ идемпотентности НОВЫЙ на каждое нажатие: он одноразовый, и
 * повтор со старым вернул бы «уже отправлено» вместо новой попытки.
 */
export async function sendLinkAction(requestId: string): Promise<ReviewActionResult> {
  const user = await requireOperator();
  const res = await sendReviewLinkAndRecord(prisma, {
    requestId,
    kind: "ASK",
    sendKey: `review-ask-${requestId}-${randomUUID()}`,
    actor: { userId: user.id },
  });
  refresh();
  return res.ok
    ? { ok: true, message: res.channel === "SMS" ? "Ссылка отправлена в SMS." : "SMS не ушла — отправили письмо." }
    : { error: res.error };
}

export async function changeLocationAction(requestId: string, locationId: string): Promise<ReviewActionResult> {
  const user = await requireOperator();
  const res = await changeRequestLocation(prisma, requestId, locationId, { userId: user.id });
  refresh();
  return res.ok ? { ok: true } : { error: res.error };
}

/** Точки магазина этого заказа — для смены точки вручную. */
export async function locationsForRequest(requestId: string) {
  await requireOperator();
  const req = await prisma.orderReviewRequest.findUnique({
    where: { id: requestId },
    select: { order: { select: { siteId: true } } },
  });
  if (!req) return [];
  return prisma.googleLocation.findMany({
    where: { siteId: req.order.siteId, isActive: true },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });
}
