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
import { resolveProfileAt } from "./profile";
import { recalculateAffectedFinance } from "./fix";
import { dayKey, readOrderContribution } from "./dayFinance";
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
  /** Дошли ли действующие расходы до денег и, если нет, почему. */
  calc: ExpenseCalcState;
};

export type ExpenseCalcState = { counted: boolean; note: string | null };

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
    calc: await expenseCalcState(orderId, rows.filter((r) => r.reversedAt == null).length),
  };
}

/**
 * Дошёл ли расход до денег.
 *
 * Нужно потому, что «сохранено» и «учтено» — разные вещи, а выглядят одинаково. Заказ в
 * работе, незакрытый день, исторический период — во всех этих случаях расход честно лежит
 * в базе и ждёт своего часа, но на выплату пока не влияет. Молчать об этом нельзя: именно
 * так выглядит «я внёс, а ничего не изменилось».
 */
export async function expenseCalcState(orderId: string, activeCount?: number): Promise<ExpenseCalcState> {
  const active =
    activeCount ?? (await prisma.orderAdditionalExpense.count({ where: { orderId, reversedAt: null } }));
  if (active === 0) return { counted: true, note: null };

  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { deliveryDate: true, currentFloristId: true, orderStatus: true },
  });
  if (!order?.currentFloristId) {
    return { counted: false, note: "У заказа нет исполнителя, поэтому расход ни на кого не отнесён." };
  }

  const profile = await resolveProfileAt(order.currentFloristId, order.deliveryDate);
  if (!profile) {
    return { counted: false, note: "У флориста нет финансового профиля на дату доставки — расход в расчёт не входит." };
  }

  if (profile.model === "SECONDARY") {
    // Удержание выводится из данных: действующий расход по доставленному заказу
    // уменьшает заработок сразу, отдельной записи в книге для этого нет.
    return order.orderStatus === "DELIVERED"
      ? { counted: true, note: "Учтено удержанием в балансе флориста." }
      : { counted: false, note: "Учтётся, когда заказ будет доставлен." };
  }

  const start = primaryShareStartDate();
  if (start && order.deliveryDate < start) {
    return { counted: false, note: "Заказ доставлен до даты запуска расчёта доли, поэтому в неё не входит." };
  }
  if (order.orderStatus !== "DELIVERED") {
    return {
      counted: false,
      note: "В расчёт пока не входит: считаются только доставленные заказы. Расход учтётся сам, когда заказ будет доставлен.",
    };
  }

  // Заказ считается только целиком посчитанным днём: пока по нему не хватает данных,
  // его вклад — и вместе с ним расход — в прибыль дня не входит.
  const contribution = await readOrderContribution(orderId);
  if (!contribution || contribution.order.missing.length > 0) {
    return {
      counted: false,
      note: "День посчитан не полностью — расход учтётся, когда будут заполнены недостающие данные (см. «Требует заполнения»).",
    };
  }
  return { counted: true, note: "Учтено в расчёте доли основного флориста." };
}

/**
 * Поучаствовал ли расход в деньгах.
 *
 * Признак теперь один: заказ доставлен. Долг флориста выводится из данных, поэтому
 * действующий расход по доставленному заказу уменьшает его сразу — без всяких записей и
 * публикаций. Прежняя проверка искала удержание в книге и опубликованную ревизию снимка;
 * ни того, ни другого больше не существует.
 */
async function usedFlags(rows: { id: string; orderId: string; createdAt: Date }[]): Promise<Map<string, boolean>> {
  const out = new Map<string, boolean>();
  if (rows.length === 0) return out;

  const delivered = await prisma.order.findMany({
    where: { id: { in: [...new Set(rows.map((r) => r.orderId))] }, orderStatus: "DELIVERED" },
    select: { id: true },
  });
  const deliveredIds = new Set(delivered.map((o) => o.id));
  for (const r of rows) out.set(r.id, deliveredIds.has(r.orderId));
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
  | { kind: "PRIMARY_DAY"; day: string; complete: boolean }
  | { kind: "SECONDARY_DEDUCTION"; deductionEntryId: string | null; reversedEntryId: string | null }
  | { kind: "NONE"; reason: string };

type OrderContext = {
  orderId: string;
  deliveryDate: Date;
  floristId: string;
  delivered: boolean;
};

async function loadOrder(orderId: string): Promise<OrderContext> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { id: true, deliveryDate: true, currentFloristId: true, orderStatus: true },
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
  return {
    orderId: order.id,
    deliveryDate: order.deliveryDate,
    floristId: order.currentFloristId,
    delivered: order.orderStatus === "DELIVERED",
  };
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

  if (profile.model === "SECONDARY") {
    // Удержание больше не записывается: у второстепенного флориста расходы по его заказам
    // вычитаются из заработка прямо при подсчёте долга (см. balance.ts). Отдельная строка
    // в книге дублировала бы этот вычет.
    return { kind: "SECONDARY_DEDUCTION", deductionEntryId: null, reversedEntryId: null };
  }

  {
    if (!order.delivered) {
      // Снимки строятся только по доставленным заказам, поэтому пересчитывать нечего.
      // Расход не потерян: он попадёт в расчёт сам, когда заказ станет доставленным.
      return { kind: "NONE", reason: "Заказ ещё не доставлен — в расчёт доли расход войдёт после доставки." };
    }
    return recomputePrimaryDay(order, actor, now);
  }
}

/** Обратная операция: снять удержание либо пересчитать день заново. */
async function settleReversal(order: OrderContext, expenseId: string, actor: ExpenseActor, now: Date): Promise<ExpenseEffect> {
  const profile = await resolveProfileAt(order.floristId, order.deliveryDate);
  if (!profile) return { kind: "NONE", reason: "У флориста нет финансового профиля на дату доставки." };

  if (profile.model === "SECONDARY") {
    return { kind: "SECONDARY_DEDUCTION", deductionEntryId: null, reversedEntryId: null };
  }
  if (!order.delivered) return { kind: "NONE", reason: "Заказ ещё не доставлен — пересчитывать нечего." };
  return recomputePrimaryDay(order, actor, now);
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

  const result = await recalculateAffectedFinance(profile.id, [order.deliveryDate], { userId: actor.userId, role: "OWNER" }, now);

  return { kind: "PRIMARY_DAY", day: dayKey(order.deliveryDate), complete: result.complete > 0 };
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
