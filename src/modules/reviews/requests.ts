import "server-only";
/**
 * Воронка запроса отзыва: карточка на заказе и её движение.
 *
 * Устройство держится на трёх правилах.
 *
 * 1. ОЧЕРЕДЬ СТРОИТСЯ ПО `nextActionAt`, А НЕ ПО СТАТУСУ. «Перезвонить завтра» иначе негде
 *    хранить: статус говорит, где мы в воронке, а срок — когда к запросу вернуться. Пустой
 *    срок означает «ждём клиента, сами ничего не делаем».
 *
 * 2. ЖУРНАЛ ТОЛЬКО ПОПОЛНЯЕТСЯ. «Звонили трижды за неделю» должно быть видно, а не стёрто
 *    последним статусом. Тот же принцип, что у книги операций в финансах.
 *
 * 3. ТОЧКА И ССЫЛКА ФИКСИРУЮТСЯ СНИМКОМ. Разметку ZIP владелец правит, точки удаляет — но
 *    «куда мы отправили этого клиента» обязано остаться правдой навсегда.
 *
 * Запрос создаётся не здесь, а пометкой владельца «Попросить отзыв» на заказе
 * (`modules/orders/marketingMark.ts`): пометка и есть решение просить отзыв, и второй способ
 * его выразить только развёл бы правду по двум местам.
 */
import type { Prisma, PrismaClient, ReviewEventKind, ReviewRequestStatus } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { pickLocation, pickedReviewUrl } from "./locationPick";

export type RequestActor = { userId: string } | null;

/** Настройки магазина с подставленными значениями по умолчанию. Строки может не быть вовсе. */
export type ReviewSettings = {
  promiseWaitDays: number;
  maxCallAttempts: number;
  callRetryDays: number;
};

export const DEFAULT_REVIEW_SETTINGS: ReviewSettings = {
  promiseWaitDays: 14,
  maxCallAttempts: 2,
  callRetryDays: 1,
};

export async function resolveReviewSettings(db: PrismaClient, siteId: string): Promise<ReviewSettings> {
  const row = await db.siteReviewSettings.findUnique({
    where: { siteId },
    select: { promiseWaitDays: true, maxCallAttempts: true, callRetryDays: true },
  });
  return row ?? DEFAULT_REVIEW_SETTINGS;
}

export function addDays(from: Date, days: number): Date {
  return new Date(from.getTime() + days * 24 * 60 * 60 * 1000);
}

type Tx = Prisma.TransactionClient;

/** Запись в журнал. Отдельной функцией, чтобы ни один переход не прошёл без следа. */
async function logEvent(
  tx: Tx,
  requestId: string,
  kind: ReviewEventKind,
  actor: RequestActor,
  detailSafe?: string | null
): Promise<void> {
  await tx.reviewRequestEvent.create({
    data: { requestId, kind, userId: actor?.userId ?? null, detailSafe: detailSafe ?? null },
  });
}

/**
 * Создать запрос по заказу. Идемпотентно: повторная пометка того же заказа возвращает уже
 * существующий запрос, а не заводит второй — второй означал бы два звонка одному клиенту.
 *
 * Заказ без точки и без старой ссылки магазина запрос ВСЁ РАВНО получает: просить отзыв
 * по-прежнему можно голосом, а ссылку владелец добавит позже. Отказать здесь значило бы
 * потерять решение владельца из-за незаполненного справочника.
 */
export async function createReviewRequest(
  db: PrismaClient,
  orderId: string,
  actor: RequestActor
): Promise<{ id: string; created: boolean }> {
  const existing = await db.orderReviewRequest.findUnique({ where: { orderId }, select: { id: true } });
  if (existing) return { id: existing.id, created: false };

  const order = await db.order.findUnique({
    where: { id: orderId },
    select: {
      zip: true,
      site: {
        select: {
          reviewUrl: true,
          googleLocations: {
            select: { id: true, name: true, reviewUrl: true, zipCode: true, isDefault: true, isActive: true },
          },
        },
      },
    },
  });
  if (!order) throw new Error(`order_not_found:${orderId}`);

  const picked = pickLocation(order.zip, order.site.googleLocations, order.site.reviewUrl);
  const locationId = picked.ok && picked.reason !== "site_fallback" ? picked.location.id : null;

  const created = await db.$transaction(async (tx) => {
    const row = await tx.orderReviewRequest.create({
      data: {
        orderId,
        locationId,
        reviewUrlSnapshot: pickedReviewUrl(picked),
        status: "NEW",
        nextActionAt: new Date(), // в очередь оператора сразу: звонить сегодня
      },
      select: { id: true },
    });
    await logEvent(tx, row.id, "CREATED", actor, picked.ok ? picked.reason : "no_location");
    return row;
  });

  return { id: created.id, created: true };
}

type Patch = {
  status?: ReviewRequestStatus;
  nextActionAt?: Date | null;
  callAttempts?: number;
  linkSentAt?: Date;
  linkChannel?: "SMS" | "EMAIL";
  promisedAt?: Date;
  remindedAt?: Date;
  confirmedAt?: Date | null;
  confirmedVia?: "GOOGLE_MATCH" | "MANUAL" | null;
  confirmedByUserId?: string | null;
  closedAt?: Date | null;
  locationId?: string | null;
  reviewUrlSnapshot?: string | null;
};

/** Общий путь любого перехода: правка полей и запись в журнал одной транзакцией. */
async function transition(
  db: PrismaClient,
  requestId: string,
  patch: Patch,
  kind: ReviewEventKind,
  actor: RequestActor,
  detailSafe?: string | null
): Promise<void> {
  await db.$transaction(async (tx) => {
    await tx.orderReviewRequest.update({ where: { id: requestId }, data: patch });
    await logEvent(tx, requestId, kind, actor, detailSafe);
  });
}

/**
 * Звонок без ответа.
 *
 * Пока попытки не исчерпаны — запрос возвращается в очередь на следующий день. Когда
 * исчерпаны, оператору звонить больше незачем: ссылку отправляет система (решение владельца
 * «две попытки — дальше пишем SMS»), поэтому здесь мы только фиксируем исчерпание, а саму
 * отправку делает `sendReviewLink`.
 */
export async function recordNoAnswer(
  db: PrismaClient,
  requestId: string,
  actor: RequestActor
): Promise<{ attempts: number; exhausted: boolean }> {
  const req = await db.orderReviewRequest.findUniqueOrThrow({
    where: { id: requestId },
    select: { callAttempts: true, order: { select: { siteId: true } } },
  });
  const settings = await resolveReviewSettings(db, req.order.siteId);
  const attempts = req.callAttempts + 1;
  const exhausted = attempts >= settings.maxCallAttempts;

  await transition(
    db,
    requestId,
    {
      status: "CALLING",
      callAttempts: attempts,
      // Исчерпали попытки — оператору сюда возвращаться не надо, дальше работает отправка.
      nextActionAt: exhausted ? null : addDays(new Date(), settings.callRetryDays),
    },
    "CALL_NO_ANSWER",
    actor,
    `attempt=${attempts}`
  );

  return { attempts, exhausted };
}

/**
 * Поговорили с клиентом, но он ещё ничего не обещал.
 *
 * Срок ОСТАЁТСЯ сегодняшним: разговор состоялся, а ссылку клиенту ещё не отправили — ход
 * по-прежнему за оператором. Снятый срок при статусе CALLING делал запрос невидимым: в
 * «сегодня» он не попадал (нет срока), в «ждут ответа» тоже (там другие статусы), и запрос
 * пропадал из работы навсегда.
 */
export async function recordTalked(db: PrismaClient, requestId: string, actor: RequestActor): Promise<void> {
  await transition(db, requestId, { status: "CALLING", nextActionAt: new Date() }, "CALL_TALKED", actor);
}

/** Клиент обещал оставить отзыв. Отсюда отсчитывается срок до напоминания. */
export async function recordPromised(db: PrismaClient, requestId: string, actor: RequestActor): Promise<void> {
  const req = await db.orderReviewRequest.findUniqueOrThrow({
    where: { id: requestId },
    select: { order: { select: { siteId: true } } },
  });
  const settings = await resolveReviewSettings(db, req.order.siteId);
  const now = new Date();

  await transition(
    db,
    requestId,
    {
      status: "PROMISED",
      promisedAt: now,
      // Срок нужен не оператору, а автоматике: по нему запрос уйдёт в «подтвердил, но забыл».
      nextActionAt: addDays(now, settings.promiseWaitDays),
    },
    "PROMISED",
    actor
  );
}

/**
 * Ссылка ушла клиенту. Срок снимается: дальше ход за клиентом, а не за оператором.
 * Оператор вернётся к запросу, когда клиент ответит, либо запрос сам уйдёт по сроку обещания.
 */
export async function recordLinkSent(
  db: PrismaClient,
  requestId: string,
  channel: "SMS" | "EMAIL",
  actor: RequestActor
): Promise<void> {
  await transition(
    db,
    requestId,
    { status: "LINK_SENT", linkSentAt: new Date(), linkChannel: channel, nextActionAt: null },
    "LINK_SENT",
    actor,
    channel
  );
}

/**
 * Отправка не удалась.
 *
 * Статус не меняем — переводить в «ссылка отправлена» нельзя, клиент ничего не получил. Но срок
 * ВОЗВРАЩАЕМ на сегодня: иначе запрос, у которого срок уже сняли (например, после исчерпания
 * попыток звонка), выпадал из всех вкладок оператора и терялся молча — а именно в этом случае
 * с ним и надо разобраться руками.
 */
export async function recordLinkFailed(
  db: PrismaClient,
  requestId: string,
  code: string,
  actor: RequestActor
): Promise<void> {
  await db.$transaction(async (tx) => {
    await tx.orderReviewRequest.update({ where: { id: requestId }, data: { nextActionAt: new Date() } });
    await tx.reviewRequestEvent.create({
      data: { requestId, kind: "LINK_FAILED", userId: actor?.userId ?? null, detailSafe: code },
    });
  });
}

/** Клиент говорит, что отзыв уже оставлен, — на проверку. */
export async function recordClaimed(db: PrismaClient, requestId: string, actor: RequestActor): Promise<void> {
  await transition(db, requestId, { status: "READY_TO_CHECK", nextActionAt: null }, "CLAIMED", actor);
}

/**
 * Отзыв засчитан.
 *
 * `via` различает найденное в Google и засчитанное по слову клиента. Владелец решил, что
 * скриншота достаточно (Google придерживает публикацию), но в статистике эти два случая не
 * должны выглядеть одинаково достоверными.
 */
export async function confirmReview(
  db: PrismaClient,
  requestId: string,
  via: "GOOGLE_MATCH" | "MANUAL",
  actor: RequestActor
): Promise<void> {
  const now = new Date();
  await transition(
    db,
    requestId,
    {
      status: "CONFIRMED",
      confirmedAt: now,
      confirmedVia: via,
      confirmedByUserId: actor?.userId ?? null,
      nextActionAt: null,
      closedAt: now,
    },
    "CONFIRMED",
    actor,
    via
  );
}

/** Клиент отказался. Больше не беспокоим — по этому заказу. */
export async function declineReview(db: PrismaClient, requestId: string, actor: RequestActor): Promise<void> {
  const now = new Date();
  await transition(db, requestId, { status: "DECLINED", nextActionAt: null, closedAt: now }, "DECLINED", actor);
}

/** Сдались: попытки и сроки исчерпаны. */
export async function giveUpReview(db: PrismaClient, requestId: string, actor: RequestActor): Promise<void> {
  const now = new Date();
  await transition(db, requestId, { status: "GAVE_UP", nextActionAt: null, closedAt: now }, "GAVE_UP", actor);
}

/**
 * Вернуть закрытый запрос в работу. Нужен, потому что закрытие — решение человека, а человек
 * ошибается: без этого единственным выходом было бы завести второй запрос по заказу, чего
 * уникальность не позволяет.
 */
export async function reopenReview(db: PrismaClient, requestId: string, actor: RequestActor): Promise<void> {
  await transition(
    db,
    requestId,
    // Каждое поле подтверждения гасим ЯВНО: `undefined` в Prisma означает «не менять», и
    // запрос возвращался в работу, оставаясь помеченным как подтверждённый.
    {
      status: "NEW",
      nextActionAt: new Date(),
      closedAt: null,
      confirmedAt: null,
      confirmedVia: null,
      confirmedByUserId: null,
    },
    "REOPENED",
    actor
  );
}

/** Сменить точку вручную: подстановка по ZIP — догадка, а оператор говорит с клиентом. */
export async function changeRequestLocation(
  db: PrismaClient,
  requestId: string,
  locationId: string,
  actor: RequestActor
): Promise<{ ok: true } | { ok: false; error: string }> {
  const [req, location] = await Promise.all([
    db.orderReviewRequest.findUnique({ where: { id: requestId }, select: { order: { select: { siteId: true } } } }),
    db.googleLocation.findUnique({ where: { id: locationId }, select: { siteId: true, name: true, reviewUrl: true } }),
  ]);
  if (!req) return { ok: false, error: "Запрос не найден." };
  if (!location) return { ok: false, error: "Точка не найдена." };
  // Точка чужого магазина увела бы клиента писать отзыв не тому бизнесу.
  if (location.siteId !== req.order.siteId) return { ok: false, error: "Точка принадлежит другому магазину." };

  await transition(
    db,
    requestId,
    { locationId, reviewUrlSnapshot: location.reviewUrl },
    "LOCATION_CHANGED",
    actor,
    location.name
  );
  return { ok: true };
}

/** Запрос по заказу — для карточки заказа и для очереди. */
export async function getRequestByOrder(orderId: string) {
  return prisma.orderReviewRequest.findUnique({
    where: { orderId },
    include: {
      location: { select: { id: true, name: true } },
      events: { orderBy: { createdAt: "desc" }, include: { user: { select: { name: true } } } },
    },
  });
}
