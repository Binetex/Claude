/**
 * Airwallex Monitoring — вся чистая логика Фазы B: нормализация статуса, планирование
 * следующей проверки, решения об алертах и записи в audit. Без БД и сети — тестируется целиком.
 *
 * Режим наблюдения: здесь НЕТ решений, меняющих business status заказа. Только собственное
 * состояние AirwallexPayment, планирование опроса и события владельцу.
 */

// ── Централизованные константы (не размазывать по коду) ──
export const MAX_MONITOR_DAYS = 7; // потолок мониторинга от firstSeenAt
export const NOT_FOUND_MAX = 3; // столько подряд 404 → закрыть как NOT_FOUND
export const NOT_FOUND_MIN_AGE_MIN = 15; // младше — intent мог не появиться в Airwallex, не закрывать
export const ERROR_SAFE_WARN_AFTER = 5; // столько подряд ошибок → показать владельцу safeError (без Telegram)
export const HEARTBEAT_AUDIT_MIN = 360; // редкая audit-запись при неизменном состоянии (6ч)

/** Интервалы следующей проверки, минуты. */
export const INTERVAL_MIN = {
  PENDING: 5,
  AUTHORIZED_NOT_CAPTURED: 10,
  ACTION_REQUIRED: 15,
  NOT_STARTED: 30,
  FAILED_CONTROL: 30, // одна контрольная после первого FAILED
  FAILED_RARE: 360, // дальше редкий опрос (6ч), а не полный стоп
} as const;

export type NormalizedStatus =
  | "PAID" | "AUTHORIZED_NOT_CAPTURED" | "PENDING" | "ACTION_REQUIRED"
  | "FAILED" | "NOT_STARTED" | "CANCELLED" | "NOT_FOUND" | "UNKNOWN";

const FAILED_ATTEMPT = new Set(["FAILED", "EXPIRED", "CANCELLED"]);

/**
 * Нормализация ТОЛЬКО по ответу Airwallex (intent status + latest_payment_attempt).
 * Woo-статус здесь не участвует принципиально.
 */
export function normalize(intentStatus: string, attemptStatus: string | null): NormalizedStatus {
  switch ((intentStatus ?? "").toUpperCase()) {
    case "SUCCEEDED": return "PAID";
    case "REQUIRES_CAPTURE": return "AUTHORIZED_NOT_CAPTURED";
    case "PENDING":
    case "PENDING_REVIEW": return "PENDING";
    case "REQUIRES_CUSTOMER_ACTION": return "ACTION_REQUIRED";
    case "CANCELLED": return "CANCELLED";
    case "REQUIRES_PAYMENT_METHOD":
      if (attemptStatus && FAILED_ATTEMPT.has(attemptStatus.toUpperCase())) return "FAILED";
      // Нет попытки (или незавершённая) — intent создан, но оплата не начата/не прошла.
      return "NOT_STARTED";
    default: return "UNKNOWN";
  }
}

const FINAL = new Set<NormalizedStatus>(["PAID", "CANCELLED"]);
export function isFinal(s: NormalizedStatus): boolean { return FINAL.has(s); }

// ── Вход/выход планировщика ──
export type ReconcileState = {
  normalizedStatus: NormalizedStatus | null;
  lastRawStatus: string | null;
  lastAttemptId: string | null;
  lastAttemptStatus: string | null;
  firstSeenAt: Date;
  firstPendingAt: Date | null;
  stopCheckingAt: Date | null;
  pendingAlertSentAt: Date | null;
  failedAlertAttemptId: string | null;
  notFoundCount: number;
  consecutiveErrorCount: number;
  safeError: string | null;
  /** ТЕКУЩИЙ payment_method заказа — для «gateway switch» и осторожного NOT_FOUND. */
  currentPaymentMethod: string | null;
  pendingThresholdMin: number;
};

export type CheckResult =
  | { kind: "found"; rawStatus: string; attemptId: string | null; attemptStatus: string | null }
  | { kind: "not_found" }
  | { kind: "error"; code: string };

export type AlertType = "payment.failed" | "payment.pending_too_long" | "payment.not_found";

export type ReconcilePlan = {
  patch: {
    normalizedStatus: NormalizedStatus | null;
    lastRawStatus: string | null;
    lastAttemptId: string | null;
    lastAttemptStatus: string | null;
    firstPendingAt: Date | null;
    nextCheckAt: Date | null;
    monitoringActive: boolean;
    notFoundCount: number;
    consecutiveErrorCount: number;
    pendingAlertSentAt: Date | null;
    failedAlertAttemptId: string | null;
    safeError: string | null;
  };
  /** Алерты владельцу (кроме mismatch — тот решается лениво в сервисе). */
  alerts: { type: AlertType; attemptId: string | null }[];
  /** Записать AirwallexCheck по содержательной причине (heartbeat решает сервис). */
  writeAudit: boolean;
  outcome: string;
  /** Airwallex расходится с локальной оплатой — сервис делает ленивый Woo-GET. */
  suspectMismatch: boolean;
};

const AIRWALLEX_METHODS = new Set(["airwallex_card", "airwallex_klarna", "airwallex_afterpay"]);
export function isAirwallexMethod(m: string | null | undefined): boolean {
  return !!m && AIRWALLEX_METHODS.has(m);
}

const addMin = (d: Date, m: number) => new Date(d.getTime() + m * 60_000);
const minutesBetween = (a: Date, b: Date) => (a.getTime() - b.getTime()) / 60_000;

/**
 * Ядро state machine. Чистая функция: текущее состояние + результат проверки → план.
 * Локальные признаки оплаты (для mismatch) передаются отдельно, чтобы не смешивать с Airwallex.
 */
export function planReconcile(
  st: ReconcileState,
  result: CheckResult,
  now: Date,
  local: { paymentStatus: string; externalStatus: string | null }
): ReconcilePlan {
  // Смена gateway (текущий метод уже не Airwallex) — останавливаем, это не наш платёж.
  if (!isAirwallexMethod(st.currentPaymentMethod)) {
    return stopPlan(st, "skipped_gateway", { normalizedStatus: st.normalizedStatus });
  }

  // ── Ошибка API: backoff, не алертим, safeError после порога ──
  if (result.kind === "error") {
    const n = st.consecutiveErrorCount + 1;
    const backoff = Math.min(5 * 2 ** (n - 1), 60);
    return capByStop(st, now, {
      ...basePatch(st),
      consecutiveErrorCount: n,
      nextCheckAt: addMin(now, backoff),
      monitoringActive: true,
      safeError: n >= ERROR_SAFE_WARN_AFTER ? safe(result.code) : st.safeError,
    }, { alerts: [], writeAudit: true, outcome: "error", suspectMismatch: false });
  }

  // ── 404 ──
  if (result.kind === "not_found") {
    const everFound = st.lastRawStatus != null;
    if (everFound) {
      // Раньше находился, теперь 404 — подозрительно. НЕ закрываем, лечим как ошибку.
      const n = st.consecutiveErrorCount + 1;
      return capByStop(st, now, {
        ...basePatch(st),
        consecutiveErrorCount: n,
        nextCheckAt: addMin(now, Math.min(5 * 2 ** (n - 1), 60)),
        monitoringActive: true,
        safeError: "Intent перестал находиться в Airwallex — требуется проверка.",
      }, { alerts: [], writeAudit: true, outcome: "error", suspectMismatch: false });
    }
    const count = st.notFoundCount + 1;
    const ageMin = minutesBetween(now, st.firstSeenAt);
    // Закрываем только после N подряд И если заказ достаточно «старый» (intent мог не появиться).
    if (count >= NOT_FOUND_MAX && ageMin >= NOT_FOUND_MIN_AGE_MIN) {
      return { patch: { ...basePatch(st), normalizedStatus: "NOT_FOUND", notFoundCount: count, nextCheckAt: null, monitoringActive: false, safeError: st.safeError }, alerts: [{ type: "payment.not_found", attemptId: null }], writeAudit: true, outcome: "not_found", suspectMismatch: false };
    }
    const schedule = [5, 15]; // count 1 → +5, count 2 → +15, дальше +30 до закрытия
    const wait = schedule[count - 1] ?? 30;
    return capByStop(st, now, {
      ...basePatch(st),
      normalizedStatus: st.normalizedStatus, // не фиксируем NOT_FOUND, пока не закрыли
      notFoundCount: count,
      nextCheckAt: addMin(now, wait),
      monitoringActive: true,
      safeError: st.safeError,
    }, { alerts: [], writeAudit: st.notFoundCount === 0, outcome: "not_found_retry", suspectMismatch: false });
  }

  // ── Успешный ответ ──
  const norm = normalize(result.rawStatus, result.attemptStatus);
  const changed =
    norm !== st.normalizedStatus ||
    result.rawStatus !== st.lastRawStatus ||
    result.attemptId !== st.lastAttemptId ||
    result.attemptStatus !== st.lastAttemptStatus;

  const common = {
    ...basePatch(st),
    normalizedStatus: norm,
    lastRawStatus: result.rawStatus,
    lastAttemptId: result.attemptId,
    lastAttemptStatus: result.attemptStatus,
    notFoundCount: 0,
    consecutiveErrorCount: 0,
    safeError: null as string | null,
  };
  const suspectMismatch = mismatchSuspected(norm, local);

  switch (norm) {
    case "PAID":
    case "CANCELLED":
      return { patch: { ...common, nextCheckAt: null, monitoringActive: false }, alerts: [], writeAudit: true, outcome: norm === "PAID" ? "reconciled" : "cancelled", suspectMismatch };

    case "FAILED": {
      // Первый FAILED для этой попытки → алерт + контрольная 30 мин. Повтор той же попытки → редкий 6ч.
      const firstForAttempt = st.failedAlertAttemptId !== result.attemptId;
      const wait = firstForAttempt ? INTERVAL_MIN.FAILED_CONTROL : INTERVAL_MIN.FAILED_RARE;
      return capByStop(st, now, {
        ...common,
        nextCheckAt: addMin(now, wait),
        monitoringActive: true,
        pendingAlertSentAt: st.pendingAlertSentAt,
        failedAlertAttemptId: firstForAttempt ? result.attemptId : st.failedAlertAttemptId,
      }, { alerts: firstForAttempt ? [{ type: "payment.failed", attemptId: result.attemptId }] : [], writeAudit: changed || firstForAttempt, outcome: "failed", suspectMismatch });
    }

    case "PENDING": {
      const firstPendingAt = st.firstPendingAt ?? now;
      const overThreshold = minutesBetween(now, firstPendingAt) >= st.pendingThresholdMin;
      const alertPending = overThreshold && !st.pendingAlertSentAt;
      return capByStop(st, now, {
        ...common,
        firstPendingAt,
        nextCheckAt: addMin(now, INTERVAL_MIN.PENDING),
        monitoringActive: true,
        pendingAlertSentAt: alertPending ? now : st.pendingAlertSentAt,
      }, { alerts: alertPending ? [{ type: "payment.pending_too_long", attemptId: result.attemptId }] : [], writeAudit: changed || alertPending, outcome: "pending", suspectMismatch });
    }

    case "AUTHORIZED_NOT_CAPTURED":
      return capByStop(st, now, { ...common, nextCheckAt: addMin(now, INTERVAL_MIN.AUTHORIZED_NOT_CAPTURED), monitoringActive: true }, { alerts: [], writeAudit: changed, outcome: "pending", suspectMismatch });
    case "ACTION_REQUIRED":
      return capByStop(st, now, { ...common, nextCheckAt: addMin(now, INTERVAL_MIN.ACTION_REQUIRED), monitoringActive: true }, { alerts: [], writeAudit: changed, outcome: "pending", suspectMismatch });
    case "NOT_STARTED":
      return capByStop(st, now, { ...common, nextCheckAt: addMin(now, INTERVAL_MIN.NOT_STARTED), monitoringActive: true }, { alerts: [], writeAudit: changed, outcome: "pending", suspectMismatch });

    case "UNKNOWN":
    default: {
      const n = st.consecutiveErrorCount + 1;
      return capByStop(st, now, { ...common, consecutiveErrorCount: n, nextCheckAt: addMin(now, Math.min(5 * 2 ** (n - 1), 60)), monitoringActive: true, safeError: n >= ERROR_SAFE_WARN_AFTER ? "Airwallex вернул неизвестный статус." : st.safeError }, { alerts: [], writeAudit: changed, outcome: "unknown", suspectMismatch: false });
    }
  }
}

/** stopCheckingAt = firstSeenAt + MAX_MONITOR_DAYS. Ставится ОДИН РАЗ при создании записи. */
export function initialStopAt(firstSeenAt: Date): Date {
  return new Date(firstSeenAt.getTime() + MAX_MONITOR_DAYS * 24 * 60 * 60_000);
}

/** Потолок по возрасту: нефинальный статус после stopCheckingAt → сдаёмся без вердикта. */
function capByStop(
  st: ReconcileState,
  now: Date,
  patch: ReconcilePlan["patch"],
  rest: Omit<ReconcilePlan, "patch">
): ReconcilePlan {
  if (st.stopCheckingAt && now.getTime() >= st.stopCheckingAt.getTime() && !isFinal(patch.normalizedStatus ?? "UNKNOWN")) {
    return { patch: { ...patch, nextCheckAt: null, monitoringActive: false }, ...rest, outcome: rest.outcome === "error" ? "error" : "gave_up" };
  }
  return { patch, ...rest };
}

function stopPlan(st: ReconcileState, outcome: string, over: Partial<ReconcilePlan["patch"]>): ReconcilePlan {
  return {
    patch: { ...basePatch(st), nextCheckAt: null, monitoringActive: false, ...over },
    alerts: [], writeAudit: true, outcome, suspectMismatch: false,
  };
}

function basePatch(st: ReconcileState): ReconcilePlan["patch"] {
  return {
    normalizedStatus: st.normalizedStatus,
    lastRawStatus: st.lastRawStatus,
    lastAttemptId: st.lastAttemptId,
    lastAttemptStatus: st.lastAttemptStatus,
    firstPendingAt: st.firstPendingAt,
    nextCheckAt: null,
    monitoringActive: true,
    notFoundCount: st.notFoundCount,
    consecutiveErrorCount: st.consecutiveErrorCount,
    pendingAlertSentAt: st.pendingAlertSentAt,
    failedAlertAttemptId: st.failedAlertAttemptId,
    safeError: st.safeError,
  };
}

/** Быстрое подозрение на расхождение — сравнение с локальной оплатой (без Woo-запроса). */
function mismatchSuspected(norm: NormalizedStatus, local: { paymentStatus: string; externalStatus: string | null }): boolean {
  if (norm === "PAID" && local.paymentStatus !== "PAID") return true; // Airwallex оплачен, у нас нет
  if (norm === "FAILED" && local.paymentStatus === "PAID") return true; // у нас оплачен, Airwallex провал
  return false;
}

/** Тип подтверждённого mismatch по свежим Woo-данным (пусто = mismatch не подтвердился). */
export function confirmMismatch(
  norm: NormalizedStatus,
  woo: { paymentMethod: string | null; datePaid: string | null; transactionId: string | null }
): "airwallex_paid_woo_unpaid" | "airwallex_failed_woo_paid" | null {
  const wooPaid = !!woo.datePaid || !!woo.transactionId;
  if (norm === "PAID" && !wooPaid) return "airwallex_paid_woo_unpaid";
  if (norm === "FAILED" && wooPaid) return "airwallex_failed_woo_paid";
  return null;
}

function safe(code: string): string {
  return `Airwallex API: ${code}`;
}
