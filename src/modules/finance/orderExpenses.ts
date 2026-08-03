import "server-only";
/**
 * Дополнительные расходы по заказу: повторная доставка, переделка букета, компенсация.
 *
 * Два разных финансовых исхода, и путать их нельзя — иначе расход учтётся дважды:
 *
 *   PRIMARY. Расход входит в расходы ЗАКАЗА и уменьшает распределяемую прибыль дня.
 *   Флорист несёт свою долю (66.6%), а не всю сумму. Никакой отдельной записи в книге не
 *   создаётся: пересчёт дня сам решит, менять начисление или нет.
 *
 *   SECONDARY. У него фиксированная цена заказа, уменьшать в ней нечего — начисление
 *   неизменяемо. Расход оформляется отдельным DEDUCTION на ПОЛНУЮ сумму, доллар в доллар.
 *
 * Снимки строятся только по заказам основного флориста, поэтому эти два пути не
 * пересекаются: у заказа SECONDARY снимка нет, у заказа PRIMARY удержания нет.
 *
 * Отмена вместо удаления — как только расход поучаствовал в расчёте. Пока не поучаствовал,
 * удаляется физически: держать в базе строку, которая ничего не объясняет, незачем.
 */
import type { Role } from "@/generated/prisma/enums";
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { appendEntry } from "./ledger";
import { reversalKey } from "./ledgerRules";
import { resolveProfileAt } from "./profile";
import { republishAndDetect } from "./fix";
import { accrueDayShare } from "./primaryShare";
import { dayKey } from "./snapshot";
import { primaryShareStartDate } from "./config";

export class OrderExpenseError extends Error {
  constructor(
    public readonly reason: string,
    message: string
  ) {
    super(message);
    this.name = "OrderExpenseError";
  }
}

export type ExpenseActor = { userId: string; role: Role; floristId?: string | null };

export type OrderExpenseRow = {
  id: string;
  amountCents: number;
  description: string;
  expenseDate: Date;
  reversedAt: Date | null;
  reversalReason: string | null;
  /** Расход уже поучаствовал в расчёте — исправляется только отменой. */
  used: boolean;
};

export type OrderExpensesView = {
  rows: OrderExpenseRow[];
  /** Сумма ДЕЙСТВУЮЩИХ расходов. Отменённые в итог не входят. */
  totalCents: number;
  canEdit: boolean;
};

/** Ключ удержания. Формат — часть контракта с БД, менять нельзя. */
export function expenseDeductionKey(expenseId: string): string {
  return `ORDER_EXPENSE_DEDUCTION:${expenseId}:v1`;
}

// ─────────────────────────── Доступ ───────────────────────────

/**
 * Может ли актор работать с расходами этого заказа.
 *
 * Правило то же, что и у самой карточки заказа: владелец и колл-центр видят любой заказ,
 * флорист — только свой. Отдельного подтверждения владельцем расход не требует.
 */
export async function canManageOrderExpenses(orderId: string, actor: ExpenseActor): Promise<boolean> {
  if (actor.role === "OWNER" || actor.role === "CALL_CENTER") return true;
  if (actor.role !== "FLORIST" || !actor.floristId) return false;
  const order = await prisma.order.findFirst({
    where: { id: orderId, currentFloristId: actor.floristId },
    select: { id: true },
  });
  return order != null;
}

async function assertAccess(orderId: string, actor: ExpenseActor): Promise<void> {
  if (!(await canManageOrderExpenses(orderId, actor))) {
    throw new OrderExpenseError("forbidden", "Нет доступа к этому заказу.");
  }
}

function assertAmount(cents: number): void {
  if (!Number.isInteger(cents) || cents <= 0) {
    throw new OrderExpenseError("bad_amount", "Сумма расхода должна быть больше нуля.");
  }
}

// ─────────────────────────── Чтение ───────────────────────────

/** Действующие расходы заказа — то, что входит в расчёт. */
export async function activeExpenseCentsByOrder(orderIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (orderIds.length === 0) return out;
  const rows = await prisma.orderAdditionalExpense.findMany({
    where: { orderId: { in: orderIds }, reversedAt: null },
    select: { orderId: true, amountCents: true },
  });
  for (const r of rows) out.set(r.orderId, (out.get(r.orderId) ?? 0) + r.amountCents);
  return out;
}

export async function listOrderExpenses(orderId: string, actor: ExpenseActor): Promise<OrderExpensesView> {
  const canEdit = await canManageOrderExpenses(orderId, actor);
  const rows = await prisma.orderAdditionalExpense.findMany({
    where: { orderId },
    orderBy: [{ expenseDate: "desc" }, { createdAt: "desc" }],
  });

  const used = await usedFlags(rows.map((r) => ({ id: r.id, orderId: r.orderId, createdAt: r.createdAt })));

  return {
    rows: rows.map((r) => ({
      id: r.id,
      amountCents: r.amountCents,
      description: r.description,
      expenseDate: r.expenseDate,
      reversedAt: r.reversedAt,
      reversalReason: r.reversalReason,
      used: used.get(r.id) ?? false,
    })),
    totalCents: rows.filter((r) => r.reversedAt == null).reduce((a, r) => a + r.amountCents, 0),
    canEdit,
  };
}

/**
 * Поучаствовал ли расход в расчёте.
 *
 * Два признака, и достаточно любого: по нему создано удержание (SECONDARY) либо после его
 * появления вышла новая опубликованная ревизия снимка заказа (PRIMARY). Ошибаться здесь
 * безопаснее в сторону «поучаствовал»: лишняя отмена сохранит историю, а лишнее удаление
 * её сотрёт.
 */
async function usedFlags(rows: { id: string; orderId: string; createdAt: Date }[]): Promise<Map<string, boolean>> {
  const out = new Map<string, boolean>();
  if (rows.length === 0) return out;

  const keys = rows.map((r) => expenseDeductionKey(r.id));
  const deductions = await prisma.ledgerEntry.findMany({
    where: { idempotencyKey: { in: keys } },
    select: { idempotencyKey: true },
  });
  const withDeduction = new Set(deductions.map((d) => d.idempotencyKey));

  const snapshots = await prisma.orderFinancialSnapshot.findMany({
    where: { orderId: { in: [...new Set(rows.map((r) => r.orderId))] }, status: "PUBLISHED" },
    select: { orderId: true, createdAt: true },
  });

  for (const r of rows) {
    const published = snapshots.some((s) => s.orderId === r.orderId && s.createdAt >= r.createdAt);
    out.set(r.id, withDeduction.has(expenseDeductionKey(r.id)) || published);
  }
  return out;
}

// ─────────────────────────── Запись ───────────────────────────

export type ExpenseApplyResult = {
  expenseId: string;
  /** Что сделано с расходом: создан, исправлен на месте, отменён, удалён. */
  action: "CREATED" | "UPDATED" | "REVERSED" | "DELETED" | "REPLACED";
  /** Как отработал пересчёт денег. */
  effect: ExpenseEffect;
};

export type ExpenseEffect =
  | { kind: "PRIMARY_DAY"; day: string; republished: number; share: string }
  | { kind: "SECONDARY_DEDUCTION"; deductionEntryId: string | null; reversedEntryId: string | null }
  | { kind: "NONE"; reason: string };

type OrderContext = {
  orderId: string;
  deliveryDate: Date;
  floristId: string;
};

async function loadOrder(orderId: string): Promise<OrderContext> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { id: true, deliveryDate: true, currentFloristId: true },
  });
  if (!order) throw new OrderExpenseError("not_found", "Заказ не найден.");
  if (!order.currentFloristId) {
    // Владелец сознательно запретил расходы на неназначенный заказ: нераспределённых
    // расходов, о которых потом нужно вспоминать, в системе не заводится.
    throw new OrderExpenseError(
      "no_florist",
      "У заказа не назначен флорист. Назначьте исполнителя — тогда расход будет на кого отнести."
    );
  }
  return { orderId: order.id, deliveryDate: order.deliveryDate, floristId: order.currentFloristId };
}

/** Добавляет расход и сразу проводит его через расчёт. */
export async function addOrderExpense(args: {
  orderId: string;
  amountCents: number;
  description: string;
  expenseDate: Date;
  actor: ExpenseActor;
  now?: Date;
}): Promise<ExpenseApplyResult> {
  await assertAccess(args.orderId, args.actor);
  assertAmount(args.amountCents);
  const description = args.description.trim();
  if (!description) throw new OrderExpenseError("bad_description", "Опишите, за что расход.");

  const order = await loadOrder(args.orderId);

  const created = await prisma.$transaction(async (tx) => {
    const row = await tx.orderAdditionalExpense.create({
      data: {
        orderId: order.orderId,
        amountCents: args.amountCents,
        description,
        expenseDate: args.expenseDate,
        // Снимок исполнителя на момент создания: переназначение заказа расход не двигает.
        floristIdSnapshot: order.floristId,
        createdBy: args.actor.userId,
      },
      select: { id: true },
    });
    await audit(tx, row.id, "ADD_ORDER_EXPENSE", null, { amountCents: args.amountCents, description, expenseDate: args.expenseDate.toISOString() }, args.actor, description);
    return row;
  });

  const effect = await settle(order, created.id, args.actor, args.now ?? new Date());
  return { expenseId: created.id, action: "CREATED", effect };
}

/**
 * Исправляет расход.
 *
 * Пока расход не поучаствовал в расчёте — правится на месте. Как только поучаствовал,
 * молча менять строку нельзя: она объясняет уже проведённые деньги. Тогда старая
 * отменяется, а вместо неё создаётся новая, и обе видны в истории.
 */
export async function updateOrderExpense(args: {
  expenseId: string;
  amountCents: number;
  description: string;
  expenseDate: Date;
  reason?: string | null;
  actor: ExpenseActor;
  now?: Date;
}): Promise<ExpenseApplyResult> {
  assertAmount(args.amountCents);
  const description = args.description.trim();
  if (!description) throw new OrderExpenseError("bad_description", "Опишите, за что расход.");

  const existing = await prisma.orderAdditionalExpense.findUnique({ where: { id: args.expenseId } });
  if (!existing) throw new OrderExpenseError("not_found", "Расход не найден.");
  if (existing.reversedAt) throw new OrderExpenseError("already_reversed", "Расход уже отменён.");
  await assertAccess(existing.orderId, args.actor);

  const order = await loadOrder(existing.orderId);
  const used = (await usedFlags([{ id: existing.id, orderId: existing.orderId, createdAt: existing.createdAt }])).get(existing.id);

  if (!used) {
    await prisma.$transaction(async (tx) => {
      await tx.orderAdditionalExpense.update({
        where: { id: existing.id },
        data: { amountCents: args.amountCents, description, expenseDate: args.expenseDate, updatedBy: args.actor.userId },
      });
      await audit(
        tx,
        existing.id,
        "UPDATE_ORDER_EXPENSE",
        { amountCents: existing.amountCents, description: existing.description },
        { amountCents: args.amountCents, description, expenseDate: args.expenseDate.toISOString() },
        args.actor,
        args.reason ?? null
      );
    });
    const effect = await settle(order, existing.id, args.actor, args.now ?? new Date());
    return { expenseId: existing.id, action: "UPDATED", effect };
  }

  const reason = (args.reason ?? "").trim();
  if (!reason) throw new OrderExpenseError("reason_required", "Расход уже в расчёте — укажите причину исправления.");

  await reverseRow(existing, reason, args.actor, args.now ?? new Date());
  await settleReversal(order, existing.id, args.actor, args.now ?? new Date());

  const replacement = await addOrderExpense({
    orderId: existing.orderId,
    amountCents: args.amountCents,
    description,
    expenseDate: args.expenseDate,
    actor: args.actor,
    now: args.now,
  });
  return { expenseId: replacement.expenseId, action: "REPLACED", effect: replacement.effect };
}

/**
 * Убирает расход: отменяет либо удаляет.
 *
 * Пользователю в обоих случаях одна кнопка — «удалил, и пересчиталось». Разница внутри:
 * строку, по которой уже прошли деньги, стирать нельзя, поэтому она остаётся отменённой.
 */
export async function removeOrderExpense(args: {
  expenseId: string;
  reason: string;
  actor: ExpenseActor;
  now?: Date;
}): Promise<ExpenseApplyResult> {
  const existing = await prisma.orderAdditionalExpense.findUnique({ where: { id: args.expenseId } });
  if (!existing) throw new OrderExpenseError("not_found", "Расход не найден.");
  if (existing.reversedAt) throw new OrderExpenseError("already_reversed", "Расход уже отменён.");
  await assertAccess(existing.orderId, args.actor);

  const reason = args.reason.trim();
  if (!reason) throw new OrderExpenseError("reason_required", "Укажите причину.");

  const order = await loadOrder(existing.orderId);
  const now = args.now ?? new Date();
  const used = (await usedFlags([{ id: existing.id, orderId: existing.orderId, createdAt: existing.createdAt }])).get(existing.id);

  if (!used) {
    await prisma.$transaction(async (tx) => {
      await audit(
        tx,
        existing.id,
        "DELETE_ORDER_EXPENSE",
        { amountCents: existing.amountCents, description: existing.description },
        { deleted: true },
        args.actor,
        reason
      );
      await tx.orderAdditionalExpense.delete({ where: { id: existing.id } });
    });
    const effect = await settle(order, existing.id, args.actor, now);
    return { expenseId: existing.id, action: "DELETED", effect };
  }

  await reverseRow(existing, reason, args.actor, now);
  const effect = await settleReversal(order, existing.id, args.actor, now);
  return { expenseId: existing.id, action: "REVERSED", effect };
}

async function reverseRow(
  existing: { id: string; amountCents: number; description: string },
  reason: string,
  actor: ExpenseActor,
  now: Date
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.orderAdditionalExpense.update({
      where: { id: existing.id },
      data: { reversedAt: now, reversedBy: actor.userId, reversalReason: reason },
    });
    await audit(
      tx,
      existing.id,
      "REVERSE_ORDER_EXPENSE",
      { amountCents: existing.amountCents, description: existing.description },
      { reversed: true },
      actor,
      reason
    );
  });
}

// ─────────────────────────── Пересчёт ───────────────────────────

/**
 * Проводит расход через деньги: PRIMARY — пересчётом дня, SECONDARY — удержанием.
 *
 * Модель флориста резолвится на ДАТУ ДОСТАВКИ заказа, как и везде в модуле: перевод
 * флориста на другую модель в августе не должен менять правила для июльского заказа.
 */
async function settle(order: OrderContext, expenseId: string, actor: ExpenseActor, now: Date): Promise<ExpenseEffect> {
  const profile = await resolveProfileAt(order.floristId, order.deliveryDate);
  if (!profile) return { kind: "NONE", reason: "У флориста нет финансового профиля на дату доставки." };

  if (profile.model === "PRIMARY") return recomputePrimaryDay(order, actor, now);
  return applySecondaryDeduction(order, expenseId, actor);
}

/** Обратная операция: снять удержание либо пересчитать день заново. */
async function settleReversal(order: OrderContext, expenseId: string, actor: ExpenseActor, now: Date): Promise<ExpenseEffect> {
  const profile = await resolveProfileAt(order.floristId, order.deliveryDate);
  if (!profile) return { kind: "NONE", reason: "У флориста нет финансового профиля на дату доставки." };

  if (profile.model === "PRIMARY") return recomputePrimaryDay(order, actor, now);
  return reverseSecondaryDeduction(order, expenseId, actor);
}

async function recomputePrimaryDay(order: OrderContext, actor: ExpenseActor, now: Date): Promise<ExpenseEffect> {
  const start = primaryShareStartDate();
  if (start && order.deliveryDate < start) {
    // Заказы до даты запуска — исторические: их не пересчитывают и не начисляют.
    return { kind: "NONE", reason: "Заказ доставлен до даты запуска расчёта доли." };
  }

  const profile = await prisma.floristFinanceProfile.findFirst({
    where: { floristId: order.floristId, model: "PRIMARY", active: true, effectiveTo: null },
    select: { id: true },
  });
  if (!profile) return { kind: "NONE", reason: "Нет действующего профиля основного флориста." };

  const result = await republishAndDetect(profile.id, [order.deliveryDate], { userId: actor.userId, role: "OWNER" }, now);
  const outcome = await accrueDayShare(profile.id, order.deliveryDate, { userId: actor.userId, role: "OWNER" });

  return {
    kind: "PRIMARY_DAY",
    day: dayKey(order.deliveryDate),
    republished: result.republished,
    share: outcome.status,
  };
}

/**
 * Удержание на полную сумму расхода.
 *
 * Начисление за заказ НЕ трогается: оно снимок цены, зафиксированный при назначении.
 * Идемпотентность по ключу расхода — повторный проход не создаст второе удержание.
 */
async function applySecondaryDeduction(order: OrderContext, expenseId: string, actor: ExpenseActor): Promise<ExpenseEffect> {
  const expense = await prisma.orderAdditionalExpense.findUnique({ where: { id: expenseId } });
  if (!expense || expense.reversedAt) return { kind: "NONE", reason: "Расход отменён или удалён." };

  const key = expenseDeductionKey(expenseId);
  const already = await prisma.ledgerEntry.findFirst({ where: { idempotencyKey: key }, select: { id: true } });
  if (already) return { kind: "SECONDARY_DEDUCTION", deductionEntryId: already.id, reversedEntryId: null };

  const entry = await appendEntry({
    // Удержание идёт тому, кто выполнял заказ в момент создания расхода.
    floristId: expense.floristIdSnapshot,
    type: "DEDUCTION",
    amountCents: expense.amountCents,
    effectiveDate: expense.expenseDate,
    description: `Доп. расход по заказу: ${expense.description}`,
    orderId: order.orderId,
    sourceType: "ORDER",
    sourceId: order.orderId,
    idempotencyKey: key,
    metadata: { expenseId, amountCents: expense.amountCents },
    actor: { userId: actor.userId, role: "OWNER" },
  });

  return { kind: "SECONDARY_DEDUCTION", deductionEntryId: entry.id, reversedEntryId: null };
}

async function reverseSecondaryDeduction(order: OrderContext, expenseId: string, actor: ExpenseActor): Promise<ExpenseEffect> {
  const key = expenseDeductionKey(expenseId);
  const deduction = await prisma.ledgerEntry.findFirst({
    where: { idempotencyKey: key },
    select: { id: true, amountCents: true, effectiveDate: true, reversal: { select: { id: true } } },
  });
  if (!deduction) return { kind: "NONE", reason: "Удержания по этому расходу не было." };
  if (deduction.reversal) return { kind: "SECONDARY_DEDUCTION", deductionEntryId: deduction.id, reversedEntryId: deduction.reversal.id };

  // Удержание не редактируется и не удаляется: снимается отдельной записью.
  const entry = await appendEntry({
    floristId: (await prisma.orderAdditionalExpense.findUniqueOrThrow({ where: { id: expenseId }, select: { floristIdSnapshot: true } })).floristIdSnapshot,
    type: "CORRECTION",
    direction: "CREDIT",
    amountCents: deduction.amountCents,
    effectiveDate: deduction.effectiveDate,
    description: "Снятие удержания за дополнительный расход",
    comment: "Расход по заказу отменён",
    orderId: order.orderId,
    sourceType: "REVERSAL",
    sourceId: deduction.id,
    idempotencyKey: reversalKey(deduction.id),
    reversedEntryId: deduction.id,
    actor: { userId: actor.userId, role: "OWNER" },
  });

  return { kind: "SECONDARY_DEDUCTION", deductionEntryId: deduction.id, reversedEntryId: entry.id };
}

async function audit(
  tx: Prisma.TransactionClient,
  expenseId: string,
  action: string,
  before: Prisma.InputJsonValue | null,
  after: Prisma.InputJsonValue,
  actor: ExpenseActor,
  reason: string | null
): Promise<void> {
  await tx.financeAudit.create({
    data: {
      entity: "OrderAdditionalExpense",
      entityId: expenseId,
      action,
      beforeJson: before ?? Prisma.JsonNull,
      afterJson: after,
      reason,
      userId: actor.userId,
      role: actor.role,
    },
  });
}
