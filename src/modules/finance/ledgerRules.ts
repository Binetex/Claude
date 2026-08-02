/**
 * Правила ledger в чистом виде: направление операции, свёртка баланса, ключи
 * идемпотентности. Ни Prisma, ни «сейчас» — всё передаётся снаружи.
 *
 * Смысл вынесения: арифметика денег должна проверяться без базы и быть ОДНА на весь
 * проект. UI, сервис записи и отчёты складывают баланс этой же функцией — второй формулы
 * не существует.
 */
import type { LedgerDirection, LedgerEntryType } from "@/generated/prisma/enums";

/**
 * Направление, жёстко заданное типом операции. NULL означает «тип допускает оба» —
 * это ровно два ручных типа, где знак выбирает владелец.
 *
 * Дублирует CHECK-ограничение в БД сознательно: БД — последний рубеж, а здесь ошибку
 * видно до похода в базу и с понятным сообщением.
 */
const FIXED_DIRECTION: Record<LedgerEntryType, LedgerDirection | null> = {
  ORDER_ACCRUAL: "CREDIT",
  PRIMARY_FLORIST_SHARE: "CREDIT",
  BONUS: "CREDIT",
  PAYMENT_REVERSAL: "CREDIT",
  DEDUCTION: "DEBIT",
  PAYMENT: "DEBIT",
  MANUAL_ADJUSTMENT: null,
  CORRECTION: null,
};

export function fixedDirectionFor(type: LedgerEntryType): LedgerDirection | null {
  return FIXED_DIRECTION[type];
}

/** Направление операции: у большинства типов оно предопределено, у ручных — задаётся. */
export function resolveDirection(type: LedgerEntryType, requested?: LedgerDirection): LedgerDirection {
  const fixed = FIXED_DIRECTION[type];
  if (fixed) {
    if (requested && requested !== fixed) {
      throw new LedgerRuleError(`операция ${type} всегда ${fixed}, а не ${requested}`);
    }
    return fixed;
  }
  if (!requested) throw new LedgerRuleError(`для ${type} нужно явно указать направление`);
  return requested;
}

/** Противоположное направление — для сторно. */
export function oppositeDirection(direction: LedgerDirection): LedgerDirection {
  return direction === "CREDIT" ? "DEBIT" : "CREDIT";
}

/** Тип сторнирующей записи: у выплаты он свой, у всего остального — CORRECTION. */
export function reversalTypeFor(type: LedgerEntryType): LedgerEntryType {
  return type === "PAYMENT" ? "PAYMENT_REVERSAL" : "CORRECTION";
}

/**
 * Типы, которые владелец может отменить. Сторнирующие записи (CORRECTION,
 * PAYMENT_REVERSAL) сюда не входят: отмена отмены — это новая операция, а не откат.
 *
 * Живёт здесь, а не рядом с UI, СОЗНАТЕЛЬНО: из `"use client"`-модуля серверный компонент
 * получает не значение, а client-reference прокси, и любой вызов метода на нём падает в
 * рантайме (типы этого не видят). Константы, нужные обеим сторонам, держим в обычном модуле.
 */
export const REVERSIBLE_TYPES: LedgerEntryType[] = [
  "ORDER_ACCRUAL",
  "PRIMARY_FLORIST_SHARE",
  "BONUS",
  "DEDUCTION",
  "PAYMENT",
  "MANUAL_ADJUSTMENT",
];

export class LedgerRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerRuleError";
  }
}

export type BalanceInput = {
  type: LedgerEntryType;
  direction: LedgerDirection;
  amountCents: number;
};

export type FloristBalance = {
  /** Начислено за заказы (ORDER_ACCRUAL + PRIMARY_FLORIST_SHARE), уже за вычетом сторно. */
  accruedCents: number;
  bonusCents: number;
  deductionCents: number;
  /** Выплачено = выплаты минус отменённые выплаты. */
  paidCents: number;
  /** Ручные корректировки, не относящиеся к перечисленному выше (знаковая сумма). */
  adjustmentCents: number;
  /** Остаток к выплате: Σ CREDIT − Σ DEBIT. Может быть отрицательным (переплата). */
  outstandingCents: number;
};

const ZERO: FloristBalance = {
  accruedCents: 0,
  bonusCents: 0,
  deductionCents: 0,
  paidCents: 0,
  adjustmentCents: 0,
  outstandingCents: 0,
};

/**
 * Складывает баланс из записей. ЕДИНСТВЕННАЯ формула остатка в проекте.
 *
 * Разложение по колонкам («начислено», «бонусы», …) намеренно НЕ пытается угадать, к какой
 * колонке относится сторно ручной корректировки: CORRECTION уменьшает ту же категорию,
 * которую исправляет, только если это начисление или выплата — там связь однозначна.
 * Всё остальное падает в adjustment. Итог `outstandingCents` от этой раскладки не зависит:
 * он считается по direction и потому верен всегда.
 */
export function foldBalance(entries: BalanceInput[]): FloristBalance {
  const b: FloristBalance = { ...ZERO };
  for (const e of entries) {
    const signed = e.direction === "CREDIT" ? e.amountCents : -e.amountCents;
    b.outstandingCents += signed;

    switch (e.type) {
      case "ORDER_ACCRUAL":
      case "PRIMARY_FLORIST_SHARE":
        b.accruedCents += signed;
        break;
      case "BONUS":
        b.bonusCents += e.amountCents;
        break;
      case "DEDUCTION":
        b.deductionCents += e.amountCents;
        break;
      case "PAYMENT":
        b.paidCents += e.amountCents;
        break;
      case "PAYMENT_REVERSAL":
        b.paidCents -= e.amountCents;
        break;
      case "MANUAL_ADJUSTMENT":
      case "CORRECTION":
        b.adjustmentCents += signed;
        break;
    }
  }
  return b;
}

// ─────────────────────────── Ключи идемпотентности ───────────────────────────
//
// Формат ключей — часть контракта с базой (@unique). Менять их нельзя: старые записи
// перестанут дедуплицироваться, и повторная обработка создаст дубль.

/** Начисление за доставленный заказ. v1 — версия правила расчёта. */
export function orderAccrualKey(orderId: string, floristId: string): string {
  return `SECONDARY_ORDER_ACCRUAL:${orderId}:${floristId}:v1`;
}

/**
 * Повторное начисление после сторно. Привязано к id сторнированной записи, а не к
 * счётчику: сценарий 100 → 120 → 100 не даёт коллизии ключа, и порядок не важен.
 */
export function orderReaccrualKey(orderId: string, floristId: string, reversedEntryId: string): string {
  return `SECONDARY_ORDER_ACCRUAL:${orderId}:${floristId}:after:${reversedEntryId}`;
}

/** Сторно любой записи. Одна отмена на запись — это же гарантирует @unique(reversedEntryId). */
export function reversalKey(reversedEntryId: string): string {
  return `LEDGER_REVERSAL:${reversedEntryId}`;
}

/** Ручная операция владельца. Уникальность даёт сам вызывающий (uuid формы). */
export function manualKey(kind: string, floristId: string, token: string): string {
  return `MANUAL:${kind}:${floristId}:${token}`;
}
