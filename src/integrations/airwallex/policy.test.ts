/**
 * Ядро Airwallex Monitoring: нормализация и state machine. Чистые функции — без БД и сети,
 * поэтому здесь покрываются все сценарии расписания, алертов и остановки.
 */
import { describe, it, expect } from "vitest";
import {
  normalize, planReconcile, initialStopAt, confirmMismatch,
  MAX_MONITOR_DAYS, INTERVAL_MIN, NOT_FOUND_MAX,
  type ReconcileState, type NormalizedStatus,
} from "./policy";

const NOW = new Date("2026-07-24T12:00:00Z");
const local = { paymentStatus: "UNPAID", externalStatus: "airwallex-pending" };

function state(over: Partial<ReconcileState> = {}): ReconcileState {
  return {
    normalizedStatus: null, lastRawStatus: null, lastAttemptId: null, lastAttemptStatus: null,
    firstSeenAt: new Date("2026-07-24T10:00:00Z"), firstPendingAt: null,
    stopCheckingAt: initialStopAt(new Date("2026-07-24T10:00:00Z")),
    pendingAlertSentAt: null, failedAlertAttemptId: null,
    notFoundCount: 0, consecutiveErrorCount: 0, safeError: null,
    currentPaymentMethod: "airwallex_card", pendingThresholdMin: 15,
    ...over,
  };
}
const found = (rawStatus: string, attemptStatus: string | null = null, attemptId: string | null = null) =>
  ({ kind: "found", rawStatus, attemptStatus, attemptId }) as const;
const minutesFrom = (base: Date, d: Date | null) => (d ? Math.round((d.getTime() - base.getTime()) / 60_000) : null);

describe("normalize — только по ответу Airwallex", () => {
  it("таблица маппинга", () => {
    expect(normalize("SUCCEEDED", "CAPTURE_REQUESTED")).toBe("PAID");
    expect(normalize("REQUIRES_CAPTURE", null)).toBe("AUTHORIZED_NOT_CAPTURED");
    expect(normalize("PENDING", null)).toBe("PENDING");
    expect(normalize("PENDING_REVIEW", null)).toBe("PENDING");
    expect(normalize("REQUIRES_CUSTOMER_ACTION", null)).toBe("ACTION_REQUIRED");
    expect(normalize("CANCELLED", null)).toBe("CANCELLED");
    expect(normalize("WHAT_IS_THIS", null)).toBe("UNKNOWN");
  });

  it("REQUIRES_PAYMENT_METHOD различается по последней попытке", () => {
    // Наши зависшие заказы 20161/20183/20291 — attempt FAILED/EXPIRED
    expect(normalize("REQUIRES_PAYMENT_METHOD", "FAILED")).toBe("FAILED");
    expect(normalize("REQUIRES_PAYMENT_METHOD", "EXPIRED")).toBe("FAILED");
    expect(normalize("REQUIRES_PAYMENT_METHOD", "CANCELLED")).toBe("FAILED");
    // #20295 — intent есть, попытки нет: оплата шла мимо Airwallex
    expect(normalize("REQUIRES_PAYMENT_METHOD", null)).toBe("NOT_STARTED");
  });
});

describe("терминальные статусы останавливают опрос", () => {
  it("PAID → стоп", () => {
    const p = planReconcile(state(), found("SUCCEEDED", "CAPTURE_REQUESTED", "att_1"), NOW, local);
    expect(p.patch).toMatchObject({ normalizedStatus: "PAID", monitoringActive: false, nextCheckAt: null });
  });

  it("CANCELLED → стоп", () => {
    const p = planReconcile(state(), found("CANCELLED"), NOW, local);
    expect(p.patch).toMatchObject({ normalizedStatus: "CANCELLED", monitoringActive: false, nextCheckAt: null });
  });
});

describe("FAILED: контрольная 30 мин → редкий опрос 6 ч → новая попытка → PAID", () => {
  it("шаг 1: первый FAILED — алерт и контрольная через 30 мин, опрос НЕ останавливается", () => {
    const p = planReconcile(state(), found("REQUIRES_PAYMENT_METHOD", "FAILED", "att_1"), NOW, local);
    expect(p.patch.normalizedStatus).toBe("FAILED");
    expect(minutesFrom(NOW, p.patch.nextCheckAt)).toBe(INTERVAL_MIN.FAILED_CONTROL);
    expect(p.patch.monitoringActive).toBe(true);
    expect(p.alerts).toEqual([{ type: "payment.failed", attemptId: "att_1" }]);
    expect(p.patch.failedAlertAttemptId).toBe("att_1");
  });

  it("шаг 2: контрольная, та же попытка — БЕЗ повторного алерта, переход на 6 ч", () => {
    const after = state({ normalizedStatus: "FAILED", lastRawStatus: "REQUIRES_PAYMENT_METHOD", lastAttemptId: "att_1", lastAttemptStatus: "FAILED", failedAlertAttemptId: "att_1" });
    const p = planReconcile(after, found("REQUIRES_PAYMENT_METHOD", "FAILED", "att_1"), NOW, local);
    expect(minutesFrom(NOW, p.patch.nextCheckAt)).toBe(INTERVAL_MIN.FAILED_RARE); // 360
    expect(p.alerts).toEqual([]);
    expect(p.patch.monitoringActive).toBe(true); // НЕ полный стоп
    expect(p.writeAudit).toBe(false); // ничего не изменилось — историю не пишем
  });

  it("шаг 3: редкий опрос поймал НОВУЮ попытку — снова алерт и контрольная", () => {
    const rare = state({ normalizedStatus: "FAILED", lastAttemptId: "att_1", lastAttemptStatus: "FAILED", failedAlertAttemptId: "att_1", lastRawStatus: "REQUIRES_PAYMENT_METHOD" });
    const p = planReconcile(rare, found("REQUIRES_PAYMENT_METHOD", "FAILED", "att_2"), NOW, local);
    expect(p.alerts).toEqual([{ type: "payment.failed", attemptId: "att_2" }]);
    expect(minutesFrom(NOW, p.patch.nextCheckAt)).toBe(INTERVAL_MIN.FAILED_CONTROL);
    expect(p.patch.failedAlertAttemptId).toBe("att_2");
    expect(p.writeAudit).toBe(true);
  });

  it("шаг 4: новая попытка удалась → PAID и полная остановка", () => {
    const rare = state({ normalizedStatus: "FAILED", lastAttemptId: "att_2", failedAlertAttemptId: "att_2", lastRawStatus: "REQUIRES_PAYMENT_METHOD" });
    const p = planReconcile(rare, found("SUCCEEDED", "CAPTURE_REQUESTED", "att_3"), NOW, local);
    expect(p.patch).toMatchObject({ normalizedStatus: "PAID", monitoringActive: false, nextCheckAt: null });
    expect(p.outcome).toBe("reconciled");
  });
});

describe("PENDING", () => {
  it("опрос каждые 5 минут, порог ещё не пройден — алерта нет", () => {
    const p = planReconcile(state({ firstPendingAt: NOW }), found("PENDING"), NOW, local);
    expect(minutesFrom(NOW, p.patch.nextCheckAt)).toBe(INTERVAL_MIN.PENDING);
    expect(p.alerts).toEqual([]);
  });

  it("после порога — pending_too_long РОВНО один раз", () => {
    const st = state({ normalizedStatus: "PENDING", lastRawStatus: "PENDING", firstPendingAt: new Date(NOW.getTime() - 20 * 60_000) });
    const first = planReconcile(st, found("PENDING"), NOW, local);
    expect(first.alerts).toEqual([{ type: "payment.pending_too_long", attemptId: null }]);
    expect(first.patch.pendingAlertSentAt).toEqual(NOW);

    // следующий опрос — уведомление НЕ повторяется, сверка продолжается
    const second = planReconcile({ ...st, pendingAlertSentAt: NOW }, found("PENDING"), NOW, local);
    expect(second.alerts).toEqual([]);
    expect(second.patch.monitoringActive).toBe(true);
  });

  it("неизменный pending НЕ засоряет audit", () => {
    const st = state({ normalizedStatus: "PENDING", lastRawStatus: "PENDING", lastAttemptId: "att_1", lastAttemptStatus: "AUTHORIZED", firstPendingAt: NOW, pendingAlertSentAt: NOW });
    const p = planReconcile(st, found("PENDING", "AUTHORIZED", "att_1"), NOW, local);
    expect(p.writeAudit).toBe(false);
  });
});

describe("интервалы прочих нефинальных статусов", () => {
  it("AUTHORIZED_NOT_CAPTURED / ACTION_REQUIRED / NOT_STARTED", () => {
    expect(minutesFrom(NOW, planReconcile(state(), found("REQUIRES_CAPTURE"), NOW, local).patch.nextCheckAt)).toBe(INTERVAL_MIN.AUTHORIZED_NOT_CAPTURED);
    expect(minutesFrom(NOW, planReconcile(state(), found("REQUIRES_CUSTOMER_ACTION"), NOW, local).patch.nextCheckAt)).toBe(INTERVAL_MIN.ACTION_REQUIRED);
    expect(minutesFrom(NOW, planReconcile(state(), found("REQUIRES_PAYMENT_METHOD", null), NOW, local).patch.nextCheckAt)).toBe(INTERVAL_MIN.NOT_STARTED);
  });
});

describe("stopCheckingAt — потолок для ВСЕХ нефинальных состояний", () => {
  const expired = { stopCheckingAt: new Date(NOW.getTime() - 60_000) }; // потолок уже прошёл
  const cases: { raw: string; attempt: string | null; expect: NormalizedStatus }[] = [
    { raw: "PENDING", attempt: null, expect: "PENDING" },
    { raw: "REQUIRES_CAPTURE", attempt: null, expect: "AUTHORIZED_NOT_CAPTURED" },
    { raw: "REQUIRES_CUSTOMER_ACTION", attempt: null, expect: "ACTION_REQUIRED" },
    { raw: "REQUIRES_PAYMENT_METHOD", attempt: null, expect: "NOT_STARTED" },
    { raw: "REQUIRES_PAYMENT_METHOD", attempt: "FAILED", expect: "FAILED" },
  ];

  for (const c of cases) {
    it(`${c.expect} после потолка → мониторинг останавливается`, () => {
      const p = planReconcile(state(expired), found(c.raw, c.attempt, "att_x"), NOW, local);
      expect(p.patch.normalizedStatus).toBe(c.expect);
      expect(p.patch.monitoringActive).toBe(false);
      expect(p.patch.nextCheckAt).toBeNull();
      expect(p.outcome).toBe("gave_up");
    });
  }

  it("PAID после потолка всё равно фиксируется как PAID", () => {
    const p = planReconcile(state(expired), found("SUCCEEDED"), NOW, local);
    expect(p.patch.normalizedStatus).toBe("PAID");
    expect(p.outcome).toBe("reconciled");
  });

  it("потолок = firstSeenAt + MAX_MONITOR_DAYS", () => {
    const seen = new Date("2026-07-01T00:00:00Z");
    expect(initialStopAt(seen).toISOString()).toBe("2026-07-08T00:00:00.000Z");
    expect(MAX_MONITOR_DAYS).toBe(7);
  });
});

describe("смена gateway", () => {
  it("текущий метод уже не Airwallex → мониторинг останавливается без алертов", () => {
    const p = planReconcile(state({ currentPaymentMethod: "ppcp-gateway" }), found("REQUIRES_PAYMENT_METHOD", "FAILED", "att_1"), NOW, local);
    expect(p.outcome).toBe("skipped_gateway");
    expect(p.patch.monitoringActive).toBe(false);
    expect(p.alerts).toEqual([]); // #20295: payment.failed НЕ отправляем
  });
});

describe("NOT_FOUND — осторожно", () => {
  it("молодой заказ: 404 не закрывает даже на N-й раз (intent мог не появиться)", () => {
    const young = state({ firstSeenAt: new Date(NOW.getTime() - 5 * 60_000), notFoundCount: NOT_FOUND_MAX - 1 });
    const p = planReconcile(young, { kind: "not_found" }, NOW, local);
    expect(p.patch.monitoringActive).toBe(true);
    expect(p.alerts).toEqual([]);
    expect(p.patch.normalizedStatus).not.toBe("NOT_FOUND");
  });

  it("расписание повторов 5 → 15 → 30", () => {
    expect(minutesFrom(NOW, planReconcile(state(), { kind: "not_found" }, NOW, local).patch.nextCheckAt)).toBe(5);
    expect(minutesFrom(NOW, planReconcile(state({ notFoundCount: 1 }), { kind: "not_found" }, NOW, local).patch.nextCheckAt)).toBe(15);
    expect(minutesFrom(NOW, planReconcile(state({ notFoundCount: 2, firstSeenAt: NOW }), { kind: "not_found" }, NOW, local).patch.nextCheckAt)).toBe(30);
  });

  it("старый заказ + 3 подряд 404 → закрываем и уведомляем один раз", () => {
    const p = planReconcile(state({ notFoundCount: NOT_FOUND_MAX - 1 }), { kind: "not_found" }, NOW, local);
    expect(p.patch).toMatchObject({ normalizedStatus: "NOT_FOUND", monitoringActive: false, nextCheckAt: null });
    expect(p.alerts).toEqual([{ type: "payment.not_found", attemptId: null }]);
  });

  it("раньше находился, теперь 404 → подозрительная ошибка, НЕ закрываем", () => {
    const p = planReconcile(state({ lastRawStatus: "PENDING", normalizedStatus: "PENDING" }), { kind: "not_found" }, NOW, local);
    expect(p.outcome).toBe("error");
    expect(p.patch.monitoringActive).toBe(true);
    expect(p.alerts).toEqual([]);
    expect(p.patch.safeError).toContain("перестал находиться");
  });
});

describe("ошибки API", () => {
  it("экспоненциальный backoff, без Telegram", () => {
    const p1 = planReconcile(state(), { kind: "error", code: "http_500" }, NOW, local);
    expect(minutesFrom(NOW, p1.patch.nextCheckAt)).toBe(5);
    expect(p1.alerts).toEqual([]);
    const p3 = planReconcile(state({ consecutiveErrorCount: 2 }), { kind: "error", code: "http_500" }, NOW, local);
    expect(minutesFrom(NOW, p3.patch.nextCheckAt)).toBe(20);
    const pMax = planReconcile(state({ consecutiveErrorCount: 9 }), { kind: "error", code: "http_500" }, NOW, local);
    expect(minutesFrom(NOW, pMax.patch.nextCheckAt)).toBe(60); // потолок
  });

  it("после порога подряд ошибок показываем владельцу safeError (но не Telegram)", () => {
    const p = planReconcile(state({ consecutiveErrorCount: 4 }), { kind: "error", code: "rate_limited" }, NOW, local);
    expect(p.patch.safeError).toContain("rate_limited");
    expect(p.alerts).toEqual([]);
  });

  it("успешный ответ сбрасывает счётчик ошибок", () => {
    const p = planReconcile(state({ consecutiveErrorCount: 3 }), found("PENDING"), NOW, local);
    expect(p.patch.consecutiveErrorCount).toBe(0);
    expect(p.patch.safeError).toBeNull();
  });
});

describe("подозрение на mismatch (ленивый Woo-запрос)", () => {
  it("Airwallex PAID, у нас не оплачен → подозрение", () => {
    expect(planReconcile(state(), found("SUCCEEDED"), NOW, { paymentStatus: "UNPAID", externalStatus: "failed" }).suspectMismatch).toBe(true);
  });

  it("Airwallex FAILED, у нас оплачен → подозрение", () => {
    expect(planReconcile(state(), found("REQUIRES_PAYMENT_METHOD", "FAILED", "a"), NOW, { paymentStatus: "PAID", externalStatus: "processing" }).suspectMismatch).toBe(true);
  });

  it("статусы согласуются → в Woo не ходим", () => {
    expect(planReconcile(state(), found("SUCCEEDED"), NOW, { paymentStatus: "PAID", externalStatus: "processing" }).suspectMismatch).toBe(false);
    expect(planReconcile(state(), found("PENDING"), NOW, local).suspectMismatch).toBe(false);
  });

  it("подтверждение mismatch по свежим Woo-данным", () => {
    expect(confirmMismatch("PAID", { paymentMethod: "airwallex_card", datePaid: null, transactionId: null })).toBe("airwallex_paid_woo_unpaid");
    // Woo знает об оплате — расхождения нет
    expect(confirmMismatch("PAID", { paymentMethod: "airwallex_card", datePaid: "2026-07-24T10:00:00", transactionId: null })).toBeNull();
    // у нас оплата есть, Airwallex говорит провал — критично
    expect(confirmMismatch("FAILED", { paymentMethod: "airwallex_card", datePaid: "2026-07-24T10:00:00", transactionId: "int_x" })).toBe("airwallex_failed_woo_paid");
    expect(confirmMismatch("FAILED", { paymentMethod: "airwallex_card", datePaid: null, transactionId: null })).toBeNull();
  });
});
