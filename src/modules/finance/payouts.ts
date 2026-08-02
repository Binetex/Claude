import "server-only";
/**
 * Операции владельца поверх ledger: выплата, бонус, удержание, ручная корректировка.
 *
 * Здесь живут только БИЗНЕС-правила (переплата, обязательный комментарий у удержания).
 * Сама запись — всегда через appendEntry: второго пути в книгу не существует.
 */
import type { LedgerDirection } from "@/generated/prisma/enums";
import {
  appendEntry,
  findByIdempotencyKey,
  getFloristBalance,
  LedgerError,
  type AppendEntryResult,
  type LedgerActor,
} from "./ledger";
import { manualKey } from "./ledgerRules";

/** Владелец — единственный, кто пишет в книгу вручную. Проверяем и здесь, не только в action. */
function assertOwner(actor: LedgerActor): void {
  if (actor.role !== "OWNER") throw new LedgerError("forbidden", "Финансовые операции доступны только владельцу.");
}

function assertPositive(amountCents: number): void {
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw new LedgerError("bad_amount", "Сумма должна быть положительной.");
  }
}

export type PaymentArgs = {
  floristId: string;
  amountCents: number;
  effectiveDate: Date;
  comment?: string | null;
  /** Способ выплаты (наличные, Zelle, перевод) — свободный текст, необязателен. */
  method?: string | null;
  /** Ссылка/номер перевода — свободный текст, необязателен. */
  reference?: string | null;
  /** Уникальный токен формы: защищает от двойной отправки одной и той же выплаты. */
  token: string;
  /** Владелец подтвердил, что выплачивает больше остатка. */
  confirmOverpayment?: boolean;
  actor: LedgerActor;
};

export type PaymentPreview = {
  outstandingBeforeCents: number;
  outstandingAfterCents: number;
  /** true — после выплаты книга уходит в минус: нужно подтверждение. */
  requiresConfirmation: boolean;
};

/** Что будет с балансом после выплаты. Нужен форме до отправки — она показывает предупреждение. */
export async function previewPayment(floristId: string, amountCents: number): Promise<PaymentPreview> {
  const balance = await getFloristBalance(floristId);
  const after = balance.outstandingCents - amountCents;
  return {
    outstandingBeforeCents: balance.outstandingCents,
    outstandingAfterCents: after,
    requiresConfirmation: after < 0,
  };
}

/**
 * Выплата флористу. Совпадать с рассчитанным остатком НЕ обязана: владелец может выплатить
 * меньше (частичная выплата) или больше. Но уход баланса в минус — это почти всегда опечатка
 * в сумме, поэтому он требует явного подтверждения.
 */
export async function recordPayment(args: PaymentArgs): Promise<AppendEntryResult> {
  assertOwner(args.actor);
  assertPositive(args.amountCents);

  // Проверка идемпотентности идёт ПЕРЕД бизнес-правилами. Иначе повторная отправка той же
  // формы падала бы на предупреждении о переплате: остаток уже уменьшен первой выплатой,
  // и та же сумма во второй раз выглядит как выход в минус.
  const key = manualKey("PAYMENT", args.floristId, args.token);
  const existing = await findByIdempotencyKey(key);
  if (existing) return { id: existing.id, created: false };

  const preview = await previewPayment(args.floristId, args.amountCents);
  if (preview.requiresConfirmation && !args.confirmOverpayment) {
    throw new LedgerError(
      "overpayment_requires_confirmation",
      `Выплата больше остатка: после неё баланс станет ${(preview.outstandingAfterCents / 100).toFixed(2)}. Подтвердите, если это верно.`
    );
  }

  const parts = [args.method?.trim(), args.reference?.trim()].filter(Boolean);
  return appendEntry({
    floristId: args.floristId,
    type: "PAYMENT",
    amountCents: args.amountCents,
    effectiveDate: args.effectiveDate,
    description: parts.length ? `Выплата (${parts.join(", ")})` : "Выплата",
    comment: args.comment ?? null,
    sourceType: "MANUAL",
    idempotencyKey: key,
    metadata: {
      method: args.method ?? null,
      reference: args.reference ?? null,
      outstandingBeforeCents: preview.outstandingBeforeCents,
      confirmedOverpayment: preview.requiresConfirmation,
    },
    actor: args.actor,
  });
}

export type AdjustmentKind = "BONUS" | "DEDUCTION" | "MANUAL_ADJUSTMENT";

export type AdjustmentArgs = {
  floristId: string;
  kind: AdjustmentKind;
  amountCents: number;
  effectiveDate: Date;
  description: string;
  comment?: string | null;
  orderId?: string | null;
  /** Только для MANUAL_ADJUSTMENT: у бонуса и удержания направление предопределено. */
  direction?: LedgerDirection;
  token: string;
  actor: LedgerActor;
};

/**
 * Бонус, удержание или ручная корректировка.
 *
 * У удержания и произвольной корректировки комментарий ОБЯЗАТЕЛЕН: через полгода
 * «−50.00» без причины невозможно ни объяснить флористу, ни проверить.
 */
export async function recordAdjustment(args: AdjustmentArgs): Promise<AppendEntryResult> {
  assertOwner(args.actor);
  assertPositive(args.amountCents);

  // Как и у выплаты: повтор — это не новая операция, проверять её заново нечем.
  const key = manualKey(args.kind, args.floristId, args.token);
  const existing = await findByIdempotencyKey(key);
  if (existing) return { id: existing.id, created: false };

  const description = args.description.trim();
  if (!description) throw new LedgerError("bad_description", "Укажите, за что операция.");
  if (args.kind !== "BONUS" && !args.comment?.trim()) {
    throw new LedgerError("comment_required", "Для удержания и корректировки нужен комментарий с причиной.");
  }

  return appendEntry({
    floristId: args.floristId,
    type: args.kind,
    direction: args.kind === "MANUAL_ADJUSTMENT" ? args.direction : undefined,
    amountCents: args.amountCents,
    effectiveDate: args.effectiveDate,
    description,
    comment: args.comment ?? null,
    orderId: args.orderId ?? null,
    sourceType: "MANUAL",
    sourceId: args.orderId ?? null,
    idempotencyKey: key,
    actor: args.actor,
  });
}
