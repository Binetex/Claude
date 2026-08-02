import "server-only";
/**
 * Запись в ledger и чтение баланса. ЕДИНСТВЕННЫЙ путь появления финансовых операций.
 *
 * Книга append-only на уровне БД (триггер в миграции 20260802120000): update/delete
 * невозможны ничем. Поэтому здесь нет ни одной функции правки — только `appendEntry`
 * и `reverseEntry`, создающая сторнирующую запись.
 *
 * Идемпотентность даёт `idempotencyKey` с @unique: повторный вебхук, resync или повторная
 * обработка задачи воркером получают уже созданную запись, а не вторую такую же.
 */
import { Prisma } from "@/generated/prisma/client";
import type { LedgerDirection, LedgerEntryType, Role } from "@/generated/prisma/enums";
import { prisma } from "@/lib/db";
import {
  LedgerRuleError,
  foldBalance,
  oppositeDirection,
  resolveDirection,
  reversalKey,
  reversalTypeFor,
  type FloristBalance,
} from "./ledgerRules";

export { LedgerRuleError } from "./ledgerRules";
export type { FloristBalance } from "./ledgerRules";

/** Нарушение бизнес-правила выплаты/корректировки — показывается владельцу как есть. */
export class LedgerError extends Error {
  constructor(
    public readonly reason: string,
    message: string
  ) {
    super(message);
    this.name = "LedgerError";
  }
}

export type LedgerActor = { userId: string; role: Role };

export type AppendEntryArgs = {
  floristId: string;
  type: LedgerEntryType;
  /** Обязателен только для MANUAL_ADJUSTMENT/CORRECTION — у остальных типов предопределён. */
  direction?: LedgerDirection;
  amountCents: number;
  effectiveDate: Date;
  description: string;
  comment?: string | null;
  orderId?: string | null;
  sourceType: "ORDER" | "MANUAL" | "PERIOD" | "REVERSAL";
  sourceId?: string | null;
  sourceVersion?: number;
  idempotencyKey: string;
  reversedEntryId?: string | null;
  metadata?: Prisma.InputJsonValue;
  actor: LedgerActor;
};

export type AppendEntryResult = { id: string; created: boolean };

const P2002_UNIQUE = "P2002";

/**
 * Добавляет запись. Идемпотентно по `idempotencyKey`: при повторе возвращает уже
 * существующую запись с `created: false` и НЕ пишет второй аудит.
 *
 * Транзакцию можно передать снаружи (`tx`) — тогда запись и её последствия применяются
 * атомарно вместе с вызывающей операцией (сторно + новое начисление одним куском).
 */
export async function appendEntry(
  args: AppendEntryArgs,
  tx?: Prisma.TransactionClient
): Promise<AppendEntryResult> {
  const client = tx ?? prisma;

  if (!Number.isInteger(args.amountCents) || args.amountCents < 0) {
    throw new LedgerRuleError("сумма должна быть целым неотрицательным числом центов");
  }
  const direction = resolveDirection(args.type, args.direction);
  if (args.reversedEntryId && !["PAYMENT_REVERSAL", "CORRECTION"].includes(args.type)) {
    throw new LedgerRuleError(`сторнировать может только PAYMENT_REVERSAL или CORRECTION, а не ${args.type}`);
  }

  // Снимки берём в момент записи: отчёт должен читаться и через год, когда флориста
  // переименуют, а заказ уедет из активной выборки.
  const florist = await client.florist.findUnique({
    where: { id: args.floristId },
    select: { id: true, user: { select: { name: true } } },
  });
  if (!florist) throw new LedgerError("florist_not_found", "Флорист не найден.");

  const order = args.orderId
    ? await client.order.findUnique({ where: { id: args.orderId }, select: { orderNumber: true } })
    : null;
  if (args.orderId && !order) throw new LedgerError("order_not_found", "Заказ не найден.");

  try {
    const created = await client.ledgerEntry.create({
      data: {
        floristId: args.floristId,
        orderId: args.orderId ?? null,
        type: args.type,
        direction,
        amountCents: args.amountCents,
        effectiveDate: args.effectiveDate,
        description: args.description,
        comment: args.comment ?? null,
        createdBy: args.actor.userId,
        createdByRole: args.actor.role,
        sourceType: args.sourceType,
        sourceId: args.sourceId ?? null,
        sourceVersion: args.sourceVersion ?? 1,
        idempotencyKey: args.idempotencyKey,
        reversedEntryId: args.reversedEntryId ?? null,
        metadata: args.metadata,
        floristNameSnapshot: florist.user.name,
        orderNumberSnapshot: order?.orderNumber ?? null,
      },
      select: { id: true },
    });

    await client.financeAudit.create({
      data: {
        entity: "LedgerEntry",
        entityId: created.id,
        action: `LEDGER_${args.type}`,
        beforeJson: Prisma.JsonNull,
        afterJson: {
          floristId: args.floristId,
          type: args.type,
          direction,
          amountCents: args.amountCents,
          effectiveDate: args.effectiveDate.toISOString(),
          orderId: args.orderId ?? null,
          reversedEntryId: args.reversedEntryId ?? null,
          idempotencyKey: args.idempotencyKey,
        },
        reason: args.comment ?? null,
        entityNameSnapshot: florist.user.name,
        userId: args.actor.userId,
        role: args.actor.role,
      },
    });

    return { id: created.id, created: true };
  } catch (err) {
    // Повтор: запись с этим ключом уже есть — это НОРМА, а не ошибка.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === P2002_UNIQUE) {
      const existing = await client.ledgerEntry.findUnique({
        where: { idempotencyKey: args.idempotencyKey },
        select: { id: true },
      });
      if (existing) return { id: existing.id, created: false };
      // Конфликт по другому unique — например, запись уже сторнирована кем-то ещё.
      throw new LedgerError("already_reversed", "Эта операция уже отменена.");
    }
    throw err;
  }
}

/**
 * Уже созданная запись с таким ключом, если она есть.
 *
 * Нужна ДО бизнес-проверок: повтор уже совершённой операции — не новая операция, и
 * перепроверять её нечем. Без этого вторая отправка той же формы выплаты упиралась бы
 * в предупреждение о переплате (остаток-то уже уменьшен первой) и падала ошибкой вместо
 * того, чтобы тихо вернуть тот же результат.
 */
export async function findByIdempotencyKey(idempotencyKey: string): Promise<{ id: string } | null> {
  return prisma.ledgerEntry.findUnique({ where: { idempotencyKey }, select: { id: true } });
}

/**
 * Сторнирует запись: создаёт зеркальную операцию противоположного направления.
 * Оригинал не трогается (и не может быть тронут). Повторный вызов вернёт уже
 * созданное сторно — @unique на reversedEntryId это гарантирует.
 */
export async function reverseEntry(args: {
  entryId: string;
  comment: string;
  actor: LedgerActor;
  /** Дата сторно; по умолчанию — сегодня (отмена происходит сейчас, а не задним числом). */
  effectiveDate?: Date;
}): Promise<AppendEntryResult> {
  const original = await prisma.ledgerEntry.findUnique({ where: { id: args.entryId } });
  if (!original) throw new LedgerError("entry_not_found", "Операция не найдена.");
  if (original.reversedEntryId) {
    throw new LedgerError("cannot_reverse_reversal", "Нельзя отменить саму отмену — добавьте новую операцию.");
  }
  const already = await prisma.ledgerEntry.findUnique({
    where: { reversedEntryId: original.id },
    select: { id: true },
  });
  if (already) return { id: already.id, created: false };

  return appendEntry({
    floristId: original.floristId,
    type: reversalTypeFor(original.type),
    direction: oppositeDirection(original.direction),
    amountCents: original.amountCents,
    effectiveDate: args.effectiveDate ?? new Date(),
    description: `Отмена: ${original.description}`,
    comment: args.comment,
    orderId: original.orderId,
    sourceType: "REVERSAL",
    sourceId: original.id,
    idempotencyKey: reversalKey(original.id),
    reversedEntryId: original.id,
    actor: args.actor,
  });
}

// ─────────────────────────────── Чтение ───────────────────────────────

export type LedgerPeriod = { from?: Date; to?: Date };

function periodWhere(period?: LedgerPeriod): Prisma.LedgerEntryWhereInput {
  if (!period?.from && !period?.to) return {};
  return {
    effectiveDate: {
      ...(period.from ? { gte: period.from } : {}),
      ...(period.to ? { lte: period.to } : {}),
    },
  };
}

/**
 * Баланс флориста. Считается ТОЛЬКО из записей — мутируемого поля «сколько должны»
 * в схеме нет и заводить его нельзя: оно неизбежно разъедется с книгой.
 */
export async function getFloristBalance(floristId: string, period?: LedgerPeriod): Promise<FloristBalance> {
  const rows = await prisma.ledgerEntry.groupBy({
    by: ["type", "direction"],
    where: { floristId, ...periodWhere(period) },
    _sum: { amountCents: true },
  });
  return foldBalance(
    rows.map((r) => ({ type: r.type, direction: r.direction, amountCents: r._sum.amountCents ?? 0 }))
  );
}

/** Балансы сразу по нескольким флористам — один запрос вместо N (список в разделе «Финансы»). */
export async function getFloristBalances(
  floristIds: string[],
  period?: LedgerPeriod
): Promise<Map<string, FloristBalance>> {
  const result = new Map<string, FloristBalance>();
  for (const id of floristIds) result.set(id, foldBalance([]));
  if (floristIds.length === 0) return result;

  const rows = await prisma.ledgerEntry.groupBy({
    by: ["floristId", "type", "direction"],
    where: { floristId: { in: floristIds }, ...periodWhere(period) },
    _sum: { amountCents: true },
  });

  const byFlorist = new Map<string, { type: LedgerEntryType; direction: LedgerDirection; amountCents: number }[]>();
  for (const r of rows) {
    const list = byFlorist.get(r.floristId) ?? [];
    list.push({ type: r.type, direction: r.direction, amountCents: r._sum.amountCents ?? 0 });
    byFlorist.set(r.floristId, list);
  }
  for (const [id, list] of byFlorist) result.set(id, foldBalance(list));
  return result;
}

export type LedgerListFilters = LedgerPeriod & {
  types?: LedgerEntryType[];
  page?: number;
  perPage?: number;
};

const DEFAULT_PER_PAGE = 50;

/**
 * История операций флориста. `floristId` всегда приходит от вызывающего, который уже
 * проверил права: у флориста — из сессии, у владельца — из URL. Сама функция прав не знает.
 */
export async function listLedgerEntries(floristId: string, f: LedgerListFilters = {}) {
  const perPage = Math.min(Math.max(f.perPage ?? DEFAULT_PER_PAGE, 1), 200);
  const page = Math.max(f.page ?? 1, 1);
  const where: Prisma.LedgerEntryWhereInput = {
    floristId,
    ...periodWhere(f),
    ...(f.types?.length ? { type: { in: f.types } } : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.ledgerEntry.findMany({
      where,
      // Вторичная сортировка по createdAt: у записей одного дня (сторно + новое начисление)
      // порядок обязан быть детерминированным, иначе история «прыгает» между рендерами.
      orderBy: [{ effectiveDate: "desc" }, { createdAt: "desc" }],
      skip: (page - 1) * perPage,
      take: perPage,
      select: {
        id: true,
        type: true,
        direction: true,
        amountCents: true,
        effectiveDate: true,
        description: true,
        comment: true,
        createdAt: true,
        orderId: true,
        orderNumberSnapshot: true,
        reversedEntryId: true,
        createdByUser: { select: { name: true } },
      },
    }),
    prisma.ledgerEntry.count({ where }),
  ]);

  // Какие записи уже отменены — чтобы не предлагать отменить их второй раз.
  const reversedIds = new Set(
    (
      await prisma.ledgerEntry.findMany({
        where: { reversedEntryId: { in: rows.map((r) => r.id) } },
        select: { reversedEntryId: true },
      })
    ).map((r) => r.reversedEntryId!)
  );

  return {
    total,
    page,
    perPage,
    entries: rows.map((r) => ({ ...r, isReversed: reversedIds.has(r.id), isReversal: r.reversedEntryId != null })),
  };
}
