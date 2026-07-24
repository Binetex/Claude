import "server-only";
import type { PrismaClient } from "@/generated/prisma/client";
import { AirwallexClient } from "./client";
import { resolveAirwallexCreds } from "./settings";
import {
  planReconcile, confirmMismatch, initialStopAt, isAirwallexMethod,
  HEARTBEAT_AUDIT_MIN, type CheckResult, type NormalizedStatus, type ReconcileState,
} from "./policy";
import { publishTelegramNotification } from "@/integrations/telegram/events";

/**
 * Сверка одного заказа с Airwallex. Режим наблюдения: НЕ меняет business status заказа
 * (paymentStatus, paymentClassification, orderStatus), не трогает назначение, SMS, fulfillment,
 * доставку и Woo. Пишет только собственное состояние AirwallexPayment + журнал AirwallexCheck
 * и отправляет уведомления владельцу.
 *
 * Вся логика решений — в чистом policy.ts; здесь только ввод-вывод.
 */
export type ReconcileOutcome = { outcome: string; normalized?: NormalizedStatus | null };

export async function reconcileAirwallexPayment(prisma: PrismaClient, orderId: string): Promise<ReconcileOutcome> {
  const rec = await prisma.airwallexPayment.findUnique({ where: { orderId } });
  if (!rec) return { outcome: "no_record" };

  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { id: true, siteId: true, externalId: true, paymentMethod: true, paymentStatus: true, externalStatus: true },
  });
  if (!order) return { outcome: "order_gone" };

  const conn = await prisma.wooCommerceConnection.findUnique({
    where: { siteId: order.siteId },
    select: { airwallexMonitoringEnabled: true, airwallexPendingThresholdMin: true },
  });
  if (!conn?.airwallexMonitoringEnabled) return { outcome: "monitoring_disabled" };

  const now = new Date();
  const st: ReconcileState = {
    normalizedStatus: rec.normalizedStatus as NormalizedStatus | null,
    lastRawStatus: rec.lastRawStatus,
    lastAttemptId: rec.lastAttemptId,
    lastAttemptStatus: rec.lastAttemptStatus,
    firstSeenAt: rec.firstSeenAt,
    firstPendingAt: rec.firstPendingAt,
    stopCheckingAt: rec.stopCheckingAt,
    pendingAlertSentAt: rec.pendingAlertSentAt,
    failedAlertAttemptId: rec.failedAlertAttemptId,
    notFoundCount: rec.notFoundCount,
    consecutiveErrorCount: rec.consecutiveErrorCount,
    safeError: rec.safeError,
    currentPaymentMethod: order.paymentMethod,
    pendingThresholdMin: conn.airwallexPendingThresholdMin,
  };

  // Запрос к Airwallex — только если gateway всё ещё наш и есть intent.
  let result: CheckResult;
  if (!isAirwallexMethod(order.paymentMethod) || !rec.paymentIntentId) {
    result = { kind: "error", code: "skipped" }; // план всё равно отработает ветку gateway
  } else {
    const creds = await resolveAirwallexCreds(prisma, order.siteId);
    if (!creds) return { outcome: "not_configured" };
    const pi = await new AirwallexClient(creds).getPaymentIntent(rec.paymentIntentId);
    result = !pi.ok
      ? { kind: "error", code: pi.code }
      : pi.found
        ? { kind: "found", rawStatus: pi.rawStatus, attemptId: pi.latestAttemptId, attemptStatus: pi.latestAttemptStatus }
        : { kind: "not_found" };
  }

  const plan = planReconcile(st, result, now, { paymentStatus: order.paymentStatus, externalStatus: order.externalStatus });

  // ── Ленивая проверка mismatch: в Woo идём ТОЛЬКО при подозрении ──
  let mismatchType: string | null = null;
  let mismatchError: string | null = null;
  if (plan.suspectMismatch && plan.patch.normalizedStatus && order.externalId) {
    const woo = await fetchWooPaymentFacts(prisma, order.siteId, order.externalId);
    if (woo.ok) {
      mismatchType = confirmMismatch(plan.patch.normalizedStatus, woo.facts);
    } else {
      // Ошибка Woo API — это НЕ mismatch. Фиксируем безопасно и не уведомляем.
      mismatchError = `Woo API недоступен при проверке расхождения (${woo.code}).`;
    }
  }

  await prisma.airwallexPayment.update({
    where: { orderId },
    data: {
      normalizedStatus: plan.patch.normalizedStatus ?? undefined,
      lastRawStatus: plan.patch.lastRawStatus,
      lastAttemptId: plan.patch.lastAttemptId,
      lastAttemptStatus: plan.patch.lastAttemptStatus,
      firstPendingAt: plan.patch.firstPendingAt,
      lastCheckedAt: now,
      nextCheckAt: plan.patch.nextCheckAt,
      monitoringActive: plan.patch.monitoringActive,
      notFoundCount: plan.patch.notFoundCount,
      consecutiveErrorCount: plan.patch.consecutiveErrorCount,
      pendingAlertSentAt: plan.patch.pendingAlertSentAt,
      failedAlertAttemptId: plan.patch.failedAlertAttemptId,
      safeError: mismatchError ?? plan.patch.safeError,
    },
  });

  // ── Журнал: только по содержательной причине или редкий heartbeat ──
  const heartbeat = await needsHeartbeat(prisma, orderId, now);
  if (plan.writeAudit || heartbeat || mismatchType) {
    await prisma.airwallexCheck.create({
      data: {
        orderId, siteId: order.siteId,
        paymentIntentId: rec.paymentIntentId,
        attemptId: plan.patch.lastAttemptId,
        rawStatus: plan.patch.lastRawStatus,
        attemptStatus: plan.patch.lastAttemptStatus,
        normalizedStatus: plan.patch.normalizedStatus ?? undefined,
        outcome: mismatchType ? `mismatch:${mismatchType}` : plan.outcome,
        safeError: mismatchError ?? plan.patch.safeError,
      },
    });
  }

  // ── Уведомления владельцу. Ключ включает intent и попытку — повтор не спамит. ──
  for (const a of plan.alerts) {
    await publishTelegramNotification(prisma, {
      type: a.type,
      orderId,
      occurrenceKey: `${orderId}:${rec.paymentIntentId ?? "-"}:${a.attemptId ?? "-"}:${a.type}`,
      context: {
        normalized: plan.patch.normalizedStatus ?? null,
        rawStatus: plan.patch.lastRawStatus,
        attemptStatus: plan.patch.lastAttemptStatus,
      },
    });
  }
  if (mismatchType) {
    await publishTelegramNotification(prisma, {
      type: "payment.status_mismatch",
      orderId,
      occurrenceKey: `${orderId}:${rec.paymentIntentId ?? "-"}:${mismatchType}:${plan.patch.normalizedStatus}`,
      context: { mismatchType, normalized: plan.patch.normalizedStatus ?? null, rawStatus: plan.patch.lastRawStatus },
    });
  }

  return { outcome: mismatchType ? `mismatch:${mismatchType}` : plan.outcome, normalized: plan.patch.normalizedStatus };
}

/** Редкая heartbeat-запись, чтобы неизменный pending не засорял журнал. */
async function needsHeartbeat(prisma: PrismaClient, orderId: string, now: Date): Promise<boolean> {
  const last = await prisma.airwallexCheck.findFirst({ where: { orderId }, orderBy: { checkedAt: "desc" }, select: { checkedAt: true } });
  if (!last) return true; // первого результата ещё не было
  return now.getTime() - last.checkedAt.getTime() >= HEARTBEAT_AUDIT_MIN * 60_000;
}

/** Свежие признаки оплаты из Woo — только при подозрении на расхождение. */
async function fetchWooPaymentFacts(
  prisma: PrismaClient,
  siteId: string,
  externalId: string
): Promise<{ ok: true; facts: { paymentMethod: string | null; datePaid: string | null; transactionId: string | null } } | { ok: false; code: string }> {
  try {
    const { resolveWooCredentials } = await import("@/integrations/woocommerce/credentials");
    const { wooGet } = await import("@/integrations/woocommerce/client");
    const creds = await resolveWooCredentials(siteId);
    const res = await wooGet<{ payment_method?: string; date_paid?: string | null; transaction_id?: string | null }>(creds, `/orders/${externalId}`);
    const d = res.data;
    return {
      ok: true,
      facts: {
        paymentMethod: d?.payment_method ?? null,
        datePaid: d?.date_paid ?? null,
        transactionId: d?.transaction_id?.trim() ? d.transaction_id : null,
      },
    };
  } catch (err) {
    return { ok: false, code: err instanceof Error ? err.message.slice(0, 60) : "woo_error" };
  }
}

/**
 * Создаёт/обновляет запись мониторинга при приёме заказа. Смена intent id = новая попытка
 * оплаты: сбрасываем статус, алерты и расписание, старое состояние остаётся в журнале.
 */
export async function upsertAirwallexPayment(
  prisma: PrismaClient,
  input: {
    orderId: string; siteId: string; paymentIntentId: string | null; paymentMethod: string | null;
    /** Backfill старого заказа: отсчёт 7-дневного потолка от даты заказа, а не от момента вставки. */
    firstSeenAt?: Date;
  }
): Promise<{ created: boolean; intentChanged: boolean }> {
  const existing = await prisma.airwallexPayment.findUnique({ where: { orderId: input.orderId } });
  const now = new Date();

  if (!existing) {
    const firstSeenAt = input.firstSeenAt ?? now;
    await prisma.airwallexPayment.create({
      data: {
        orderId: input.orderId, siteId: input.siteId,
        paymentIntentId: input.paymentIntentId, paymentMethod: input.paymentMethod,
        firstSeenAt,
        // Потолок мониторинга ставится СРАЗУ при создании — иначе NOT_STARTED/ACTION_REQUIRED/
        // AUTHORIZED_NOT_CAPTURED/FAILED могли бы опрашиваться без ограничения.
        stopCheckingAt: initialStopAt(firstSeenAt),
        nextCheckAt: now, // новый intent проверяем сразу
        monitoringActive: true,
      },
    });
    return { created: true, intentChanged: false };
  }

  const intentChanged = !!input.paymentIntentId && input.paymentIntentId !== existing.paymentIntentId;
  if (intentChanged) {
    await prisma.airwallexCheck.create({
      data: {
        orderId: input.orderId, siteId: input.siteId,
        paymentIntentId: existing.paymentIntentId, attemptId: existing.lastAttemptId,
        rawStatus: existing.lastRawStatus, attemptStatus: existing.lastAttemptStatus,
        normalizedStatus: existing.normalizedStatus ?? undefined,
        outcome: "intent_replaced",
      },
    });
    await prisma.airwallexPayment.update({
      where: { orderId: input.orderId },
      data: {
        paymentIntentId: input.paymentIntentId, paymentMethod: input.paymentMethod,
        normalizedStatus: null, lastRawStatus: null, lastAttemptId: null, lastAttemptStatus: null,
        firstPendingAt: null, pendingAlertSentAt: null, failedAlertAttemptId: null,
        notFoundCount: 0, consecutiveErrorCount: 0, safeError: null,
        monitoringActive: true, nextCheckAt: now,
      },
    });
  } else {
    await prisma.airwallexPayment.update({
      where: { orderId: input.orderId },
      data: { paymentMethod: input.paymentMethod },
    });
  }
  return { created: false, intentChanged };
}

/** Ключ meta WooCommerce, в котором Airwallex-плагин держит payment intent (подтверждено аудитом). */
export const WOO_INTENT_META_KEY = "_tmp_airwallex_payment_intent";

export function extractIntentId(meta: { key?: string; value?: unknown }[] | undefined): string | null {
  const m = meta?.find((x) => x.key === WOO_INTENT_META_KEY);
  const v = typeof m?.value === "string" ? m.value.trim() : "";
  return v.length > 0 ? v : null;
}

/**
 * Хук приёма Woo-заказа: сохраняет intent id и, при необходимости, ставит немедленную сверку.
 * Best-effort — сбой мониторинга НЕ ломает приём заказа.
 *
 * Мониторим только заказы, у которых ТЕКУЩИЙ payment_method относится к Airwallex: наличие
 * старого _tmp_airwallex_payment_intent само по себе не основание (см. #20295 — оплата PayPal).
 */
export async function onWooOrderIngestedForAirwallex(
  prisma: PrismaClient,
  input: { orderId: string; siteId: string; paymentMethod: string | null; meta: { key?: string; value?: unknown }[] | undefined }
): Promise<void> {
  try {
    if (!isAirwallexMethod(input.paymentMethod)) return;
    const conn = await prisma.wooCommerceConnection.findUnique({
      where: { siteId: input.siteId },
      select: { airwallexMonitoringEnabled: true },
    });
    if (!conn?.airwallexMonitoringEnabled) return;

    const intentId = extractIntentId(input.meta);
    if (!intentId) return; // нечего сверять

    const { created, intentChanged } = await upsertAirwallexPayment(prisma, {
      orderId: input.orderId, siteId: input.siteId, paymentIntentId: intentId, paymentMethod: input.paymentMethod,
    });
    // Немедленная сверка только для нового заказа или новой попытки оплаты; на обычном resync
    // задачу не плодим — дальше расписание ведёт диспетчер по nextCheckAt.
    if (created || intentChanged) {
      const { publishAirwallexVerify } = await import("./events");
      await publishAirwallexVerify(prisma, input.orderId, null);
    }
  } catch (err) {
    console.error(`[airwallex] ingest hook failed for ${input.orderId}:`, err instanceof Error ? err.message : String(err));
  }
}
