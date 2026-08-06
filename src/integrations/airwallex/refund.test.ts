import { describe, it, expect } from "vitest";
import { computeRefundAmounts } from "./refund";
import type { AirwallexRefund } from "./client";

const r = (amount: number, status: string): AirwallexRefund => ({
  id: `rfd_${status}_${amount}`,
  status,
  amount,
  currency: "USD",
  reason: null,
  createdAt: null,
});

/**
 * Сколько можно вернуть. Ошибка здесь стоит настоящих денег: занизишь — владелец не сможет
 * вернуть положенное, завысишь — вернёт больше, чем клиент заплатил.
 */
describe("остаток к возврату", () => {
  it("возвратов не было — доступна вся списанная сумма", () => {
    expect(computeRefundAmounts(312.93, [])).toEqual({ refundedAmount: 0, availableAmount: 312.93 });
  });

  it("частичный возврат уменьшает остаток", () => {
    expect(computeRefundAmounts(312.93, [r(100, "SETTLED")])).toEqual({
      refundedAmount: 100,
      availableAmount: 212.93,
    });
  });

  it("несколько возвратов складываются", () => {
    expect(computeRefundAmounts(500, [r(100, "SETTLED"), r(50.5, "SETTLED")])).toEqual({
      refundedAmount: 150.5,
      availableAmount: 349.5,
    });
  });

  it("ИДУЩИЙ возврат тоже занимает сумму — иначе вернём дважды, пока первый в пути", () => {
    expect(computeRefundAmounts(200, [r(200, "RECEIVED")])).toEqual({ refundedAmount: 200, availableAmount: 0 });
    expect(computeRefundAmounts(200, [r(80, "PENDING")]).availableAmount).toBe(120);
    expect(computeRefundAmounts(200, [r(80, "PROCESSING")]).availableAmount).toBe(120);
  });

  it("несостоявшиеся возвраты сумму не занимают", () => {
    for (const dead of ["FAILED", "CANCELLED", "EXPIRED", "DECLINED"]) {
      expect(computeRefundAmounts(200, [r(200, dead)])).toEqual({ refundedAmount: 0, availableAmount: 200 });
    }
  });

  it("регистр статуса не важен — Airwallex может прислать любой", () => {
    expect(computeRefundAmounts(200, [r(200, "failed")]).availableAmount).toBe(200);
  });

  it("незнакомый статус считается занятым — осторожность важнее полноты", () => {
    // Новый статус в API не должен молча открыть возврат уже возвращённых денег.
    expect(computeRefundAmounts(200, [r(200, "SOME_NEW_STATUS")]).availableAmount).toBe(0);
  });

  it("возвращено полностью — доступно ноль, а не отрицательное число", () => {
    expect(computeRefundAmounts(312.93, [r(312.93, "SETTLED")])).toEqual({
      refundedAmount: 312.93,
      availableAmount: 0,
    });
  });

  it("возвращено больше списанного (ручные операции в кабинете) — тоже ноль, не минус", () => {
    expect(computeRefundAmounts(100, [r(150, "SETTLED")]).availableAmount).toBe(0);
  });

  it("копейки не накапливают погрешность", () => {
    const res = computeRefundAmounts(0.3, [r(0.1, "SETTLED"), r(0.1, "SETTLED")]);
    expect(res.refundedAmount).toBe(0.2);
    expect(res.availableAmount).toBe(0.1); // а не 0.09999999999999998
  });
});
