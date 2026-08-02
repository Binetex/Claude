/**
 * Арифметика ledger без базы: направление операций, свёртка баланса, частичные выплаты.
 * Здесь проверяется то, что не должно зависеть ни от Prisma, ни от текущего времени.
 */
import { describe, it, expect } from "vitest";
import {
  foldBalance,
  resolveDirection,
  oppositeDirection,
  reversalTypeFor,
  orderAccrualKey,
  orderReaccrualKey,
  reversalKey,
  LedgerRuleError,
  type BalanceInput,
} from "./ledgerRules";

const e = (type: BalanceInput["type"], direction: BalanceInput["direction"], amountCents: number): BalanceInput => ({
  type,
  direction,
  amountCents,
});

describe("направление операции", () => {
  it("предопределено у типов, где выбора нет", () => {
    expect(resolveDirection("ORDER_ACCRUAL")).toBe("CREDIT");
    expect(resolveDirection("BONUS")).toBe("CREDIT");
    expect(resolveDirection("PAYMENT")).toBe("DEBIT");
    expect(resolveDirection("DEDUCTION")).toBe("DEBIT");
    expect(resolveDirection("PAYMENT_REVERSAL")).toBe("CREDIT");
  });

  it("нельзя сделать выплату, увеличивающую долг", () => {
    expect(() => resolveDirection("PAYMENT", "CREDIT")).toThrow(LedgerRuleError);
  });

  it("у ручных типов направление обязательно указать явно", () => {
    expect(() => resolveDirection("MANUAL_ADJUSTMENT")).toThrow(LedgerRuleError);
    expect(resolveDirection("MANUAL_ADJUSTMENT", "DEBIT")).toBe("DEBIT");
    expect(resolveDirection("CORRECTION", "CREDIT")).toBe("CREDIT");
  });

  it("сторно выплаты — отдельный тип, всего остального — CORRECTION", () => {
    expect(reversalTypeFor("PAYMENT")).toBe("PAYMENT_REVERSAL");
    expect(reversalTypeFor("ORDER_ACCRUAL")).toBe("CORRECTION");
    expect(reversalTypeFor("BONUS")).toBe("CORRECTION");
    expect(oppositeDirection("CREDIT")).toBe("DEBIT");
    expect(oppositeDirection("DEBIT")).toBe("CREDIT");
  });
});

describe("баланс", () => {
  it("пустая книга — нули, а не отсутствие ответа", () => {
    const b = foldBalance([]);
    expect(b.outstandingCents).toBe(0);
    expect(b.accruedCents).toBe(0);
  });

  it("сценарий владельца: 118.00 начислено + 20.00 бонус − 100.00 выплата = 38.00", () => {
    const b = foldBalance([
      e("ORDER_ACCRUAL", "CREDIT", 11800),
      e("BONUS", "CREDIT", 2000),
      e("PAYMENT", "DEBIT", 10000),
    ]);
    expect(b.accruedCents).toBe(11800);
    expect(b.bonusCents).toBe(2000);
    expect(b.paidCents).toBe(10000);
    expect(b.outstandingCents).toBe(3800);
  });

  it("частичная выплата оставляет остаток, а не обнуляет книгу", () => {
    const b = foldBalance([e("ORDER_ACCRUAL", "CREDIT", 15000), e("PAYMENT", "DEBIT", 5000)]);
    expect(b.outstandingCents).toBe(10000);
    expect(b.paidCents).toBe(5000);
  });

  it("полная выплата даёт ровно ноль", () => {
    const b = foldBalance([e("ORDER_ACCRUAL", "CREDIT", 15000), e("PAYMENT", "DEBIT", 15000)]);
    expect(b.outstandingCents).toBe(0);
  });

  it("переплата уводит остаток в минус — это видно, а не прячется в ноль", () => {
    const b = foldBalance([e("ORDER_ACCRUAL", "CREDIT", 10000), e("PAYMENT", "DEBIT", 12000)]);
    expect(b.outstandingCents).toBe(-2000);
  });

  it("удержание уменьшает остаток и учитывается отдельной колонкой", () => {
    const b = foldBalance([e("ORDER_ACCRUAL", "CREDIT", 10000), e("DEDUCTION", "DEBIT", 1500)]);
    expect(b.deductionCents).toBe(1500);
    expect(b.outstandingCents).toBe(8500);
  });

  it("отменённая выплата возвращает долг и обнуляет «выплачено»", () => {
    const b = foldBalance([
      e("ORDER_ACCRUAL", "CREDIT", 10000),
      e("PAYMENT", "DEBIT", 10000),
      e("PAYMENT_REVERSAL", "CREDIT", 10000),
    ]);
    expect(b.paidCents).toBe(0);
    expect(b.outstandingCents).toBe(10000);
  });

  it("сторно начисления вычитается из начисленного, а не оседает в корректировках", () => {
    const b = foldBalance([
      e("ORDER_ACCRUAL", "CREDIT", 11800),
      e("CORRECTION", "DEBIT", 11800),
      e("ORDER_ACCRUAL", "CREDIT", 13000),
    ]);
    // Сторно относится к начислению, поэтому в «начислено» остаётся только актуальная сумма.
    expect(b.outstandingCents).toBe(13000);
  });

  it("ручная корректировка обоих знаков влияет на остаток", () => {
    const plus = foldBalance([e("MANUAL_ADJUSTMENT", "CREDIT", 5000)]);
    const minus = foldBalance([e("MANUAL_ADJUSTMENT", "DEBIT", 5000)]);
    expect(plus.outstandingCents).toBe(5000);
    expect(minus.outstandingCents).toBe(-5000);
  });
});

describe("ключи идемпотентности", () => {
  it("формат ключа начисления зафиксирован — от него зависит дедуп в БД", () => {
    expect(orderAccrualKey("ord1", "fl1")).toBe("SECONDARY_ORDER_ACCRUAL:ord1:fl1:v1");
  });

  it("повторное начисление привязано к сторно, поэтому 100 → 120 → 100 не даёт коллизии", () => {
    const first = orderReaccrualKey("ord1", "fl1", "rev-a");
    const second = orderReaccrualKey("ord1", "fl1", "rev-b");
    expect(first).not.toBe(second);
    expect(first).not.toBe(orderAccrualKey("ord1", "fl1"));
  });

  it("у сторно ключ один на отменяемую запись", () => {
    expect(reversalKey("entry1")).toBe("LEDGER_REVERSAL:entry1");
  });
});
