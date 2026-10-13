import "server-only";
/**
 * Новая инструкция курьеру → в Burq.
 *
 * Править созданный черновик Burq нельзя, только удалить неоформленный и создать заново — тем же
 * путём, что при смене адреса (`handleFloristReassignment`). А черновик создаётся в 4 утра дня
 * доставки, клиенты же присылают код ворот в ответ на утреннее «когда удобно принять?». Без
 * пересоздания новая инструкция до курьера не доходила бы почти никогда.
 *
 * Пересоздаём, только когда новый черновик ТОЧНО создастся сразу:
 *  - черновик наш (`burq:create:…`), а не заказ, заведённый человеком в кабинете Burq и
 *    привязанный вручную: его пересборка из наших данных потеряла бы то, что человек там настроил;
 *  - по тем же правилам, что у автосоздания (`decideDraftEligibility`), новый черновик проходит:
 *    иначе снятый черновик не заменился бы ничем (автосоздание выключено, адрес без номера дома).
 * Оформленную доставку (курьер ищется или едет) не трогаем: пересоздание отменило бы курьера.
 * Во всех случаях «не пересоздали» инструкцию курьеру должны передать люди.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { isBurqRuntimeEnabled } from "@/lib/featureFlags";
import { deliveryAddressIssue } from "@/lib/addressCheck";
import { handleFloristReassignment } from "./reassignmentService";
import { deliveryStage } from "./reassignment";
import { createPrismaDraftPort } from "./draftPort.prisma";
import { decideDraftEligibility } from "./eligibility";

export type CourierNoteBurqOutcome =
  /** Черновика ещё нет — он прочитает свежую инструкцию сам, когда будет создан. */
  | "no_draft"
  /** Черновик создан уже после записи инструкции — она в нём есть. */
  | "up_to_date"
  /** Черновик не был оформлен — снят и создан заново с новой инструкцией. */
  | "recreated"
  /** Курьер уже вызван — в Burq инструкцию не изменить. */
  | "courier_called"
  /** Черновик оставлен как был: заведён вручную или новый сейчас не создался бы. */
  | "kept"
  /** Прежний черновик снят, а новый не создался. */
  | "lost"
  /** Burq не ответил — что видит курьер, неизвестно. */
  | "burq_error"
  /** Burq выключен или доставка уже закончилась — делать нечего. */
  | "skipped";

/** Исходы, при которых курьер новой инструкции не видит и передать её должны люди. */
export const COURIER_NOTE_NEEDS_PEOPLE: readonly CourierNoteBurqOutcome[] = ["courier_called", "kept", "lost", "burq_error"];

/**
 * `writtenAt` — когда инструкция записана. Черновик моложе неё уже собран с новым текстом: так
 * бывает у заказа на сегодня, где черновик создаётся сразу после приёма.
 */
export async function pushCourierNoteToBurq(prisma: PrismaClient, orderId: string, writtenAt?: Date): Promise<CourierNoteBurqOutcome> {
  if (!isBurqRuntimeEnabled()) return "skipped";
  try {
    const current = await prisma.delivery.findFirst({
      where: { orderId, isCurrentAttempt: true, externalDeliveryId: { not: null } },
      select: { status: true, idempotencyKey: true, attemptNumber: true, createdAt: true },
    });
    if (!current) return "no_draft";
    if (writtenAt && current.createdAt >= writtenAt) return "up_to_date";
    const stage = deliveryStage(current.status);
    if (stage === "finished") return "skipped";
    if (stage === "dispatched") return "courier_called";
    if (current.idempotencyKey !== `burq:create:${orderId}:${current.attemptNumber}`) return "kept";

    const ctx = await createPrismaDraftPort(prisma).loadContext(orderId);
    if (!ctx) return "skipped";
    const decision = decideDraftEligibility({
      siteAutoCreateEnabled: ctx.order.siteAutoCreateEnabled,
      orderStatus: ctx.order.orderStatus,
      floristId: ctx.floristId,
      pickup: ctx.pickup,
      hasCurrentDraft: false, // прежний будет снят — проверяем, создастся ли новый
      deliveryDate: ctx.order.deliveryDate,
      timezone: ctx.order.timezone,
      addressIssue: deliveryAddressIssue(ctx.order.dropoff.addressLine),
    });
    if (decision.action !== "CREATE_DRAFT") return "kept";

    const res = await handleFloristReassignment(prisma, orderId, "INPUTS_CHANGED", { flagIfInitiated: false });
    switch (res.outcome) {
      case "recreated":
        return "recreated";
      case "no_current_draft":
        return "no_draft";
      case "kept_initiated":
        if (res.reason === "terminal") return "skipped";
        return res.reason === "delete_failed" ? "burq_error" : "courier_called";
      case "waiting":
        return "lost";
      case "flagged_problem":
        return "burq_error"; // с flagIfInitiated: false не бывает
    }
  } catch (err) {
    console.error(`[burq] инструкция курьеру для заказа ${orderId} не дошла до Burq:`, err instanceof Error ? err.message : String(err));
    return "burq_error";
  }
}
