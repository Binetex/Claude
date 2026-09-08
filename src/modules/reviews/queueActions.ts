"use server";
/**
 * Работа с очередью отзывов: то, что нажимает человек, разобравшись с клиентом.
 *
 * Доступ — колл-центр И владелец. Один и тот же набор действий обслуживает два экрана:
 * очередь оператора (`/dashboard/cc/reviews`) и её же вкладку в разделе владельца
 * (`/dashboard/reviews/queue`) — оператор может заболеть, а запрос закрыть надо. Флорист сюда
 * не ходит вовсе.
 *
 * Лежит в модуле, а не рядом со страницей, именно поэтому: страниц две, правда одна.
 *
 * Вся логика переходов — в соседних файлах модуля; здесь права, ключ идемпотентности и
 * обновление обеих страниц.
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
  recordIgnoring,
  confirmReview,
  declineReview,
  giveUpReview,
  reopenReview,
  changeRequestLocation,
} from "./requests";
import { sendReviewLinkAndRecord } from "./sendLink";
import { sendReviewCoupon } from "./reward";

const OPERATOR_PATH = "/dashboard/cc/reviews";
const OWNER_PATH = "/dashboard/reviews/queue";

export type ReviewActionResult = { ok?: true; message?: string; error?: string };

/** Оператор и владелец — да, флорист — нет. */
async function requireOperator() {
  const user = await requireUser();
  if (user.role === "FLORIST") throw new Error("forbidden");
  return user;
}

/** Обновляем ОБА экрана: одно и то же действие видно и оператору, и владельцу. */
function refresh(requestId?: string) {
  revalidatePath(OPERATOR_PATH);
  revalidatePath(OWNER_PATH);
  revalidatePath("/dashboard/reviews/requests");
  // И карточку запроса, если действие пришло с неё: иначе человек нажал «Поговорили» и остался
  // смотреть на прежний статус.
  if (requestId) {
    revalidatePath(`${OPERATOR_PATH}/${requestId}`);
    revalidatePath(`${OWNER_PATH}/${requestId}`);
  }
}

/**
 * Купон за отзыв — следующий шаг после обещания или засчитанного отзыва. Раньше этот шаг жил
 * только в голове: клиент обещал, а купон ему никто не отправил.
 */
export async function sendCouponAction(requestId: string): Promise<ReviewActionResult> {
  const user = await requireOperator();
  const res = await sendReviewCoupon(prisma, { requestId, actorUserId: user.id });
  refresh(requestId);
  return res.ok ? { ok: true, message: "Купон отправлен клиенту." } : { error: res.error };
}

export async function noAnswerAction(requestId: string): Promise<ReviewActionResult> {
  const user = await requireOperator();
  const res = await recordNoAnswer(prisma, requestId, { userId: user.id });
  refresh(requestId);

  // Попытки исчерпаны — ссылку отправляем сами, не дожидаясь ещё одного захода оператора.
  // Это решение владельца: «две попытки — дальше пишем SMS».
  if (res.exhausted) {
    const sent = await sendReviewLinkAndRecord(prisma, {
      requestId,
      kind: "ASK",
      sendKey: `review-ask-${requestId}-${randomUUID()}`,
      actor: { userId: user.id },
    });
    refresh(requestId);
    return sent.ok
      ? { ok: true, message: `Попытки исчерпаны — ссылка отправлена (${sent.channel === "SMS" ? "SMS" : "письмо"}).` }
      : { ok: true, message: `Попытки исчерпаны, но ссылка не ушла: ${sent.error}` };
  }
  return { ok: true, message: "Записано. Вернём в очередь на следующий день." };
}

export async function talkedAction(requestId: string): Promise<ReviewActionResult> {
  const user = await requireOperator();
  await recordTalked(prisma, requestId, { userId: user.id });
  refresh(requestId);
  return { ok: true };
}

export async function promisedAction(requestId: string): Promise<ReviewActionResult> {
  const user = await requireOperator();
  await recordPromised(prisma, requestId, { userId: user.id });
  refresh(requestId);
  return { ok: true, message: "Ждём отзыв. Если не появится — напомним сами." };
}

/** «Игнорирует» вручную: оператор видит тишину раньше, чем её увидит суточный проход. */
export async function markIgnoringAction(requestId: string): Promise<ReviewActionResult> {
  const user = await requireOperator();
  await recordIgnoring(prisma, requestId, { userId: user.id });
  refresh(requestId);
  return { ok: true, message: "Отмечено: клиент игнорирует." };
}

export async function claimedAction(requestId: string): Promise<ReviewActionResult> {
  const user = await requireOperator();
  await recordClaimed(prisma, requestId, { userId: user.id });
  refresh(requestId);
  return { ok: true };
}

export async function confirmAction(requestId: string): Promise<ReviewActionResult> {
  const user = await requireOperator();
  // Вручную — значит по слову клиента. В статистике это отличается от найденного в Google.
  await confirmReview(prisma, requestId, "MANUAL", { userId: user.id });
  refresh(requestId);
  return { ok: true };
}

export async function declineAction(requestId: string): Promise<ReviewActionResult> {
  const user = await requireOperator();
  await declineReview(prisma, requestId, { userId: user.id });
  refresh(requestId);
  return { ok: true };
}

export async function giveUpAction(requestId: string): Promise<ReviewActionResult> {
  const user = await requireOperator();
  await giveUpReview(prisma, requestId, { userId: user.id });
  refresh(requestId);
  return { ok: true };
}

export async function reopenAction(requestId: string): Promise<ReviewActionResult> {
  const user = await requireOperator();
  await reopenReview(prisma, requestId, { userId: user.id });
  refresh(requestId);
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
  refresh(requestId);
  return res.ok
    ? { ok: true, message: res.channel === "SMS" ? "Ссылка отправлена в SMS." : "SMS не ушла — отправили письмо." }
    : { error: res.error };
}

export async function changeLocationAction(requestId: string, locationId: string): Promise<ReviewActionResult> {
  const user = await requireOperator();
  const res = await changeRequestLocation(prisma, requestId, locationId, { userId: user.id });
  refresh(requestId);
  return res.ok ? { ok: true } : { error: res.error };
}
