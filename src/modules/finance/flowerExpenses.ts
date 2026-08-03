import "server-only";
/**
 * Ежедневные расходы на цветы: полная история, ввод, исправление, удаление.
 *
 * Три вещи, которые определяют устройство этого модуля.
 *
 * 1. Список строится по ОБЪЕДИНЕНИЮ дней «есть расход» и «есть доставленные заказы».
 *    Показывать только внесённые строки бессмысленно: главное, что здесь ищут, — день,
 *    который забыли заполнить, а его в таблице расходов по определению нет.
 *
 * 2. В СПИСКЕ факты дня (заказов, цветочная выручка, распределено, остаток) читаются из
 *    ОПУБЛИКОВАННЫХ снимков: снимок и есть опубликованный расчёт, а пересчёт ради каждой
 *    строки превратил бы страницу в сотни запросов. На странице ОДНОГО дня план и так
 *    строится, поэтому факты там живые — иначе итог наверху расходился бы с построчной
 *    таблицей заказов под ним.
 *
 * 3. Профиль НИКОГДА не приходит из формы. Владельцу он резолвится как действующий
 *    PRIMARY, флористу — из его сессии. Подменить чужой financeProfileId нечем.
 *
 * Расширение (тип расхода, поставщик, инвойс, файл, экспорт CSV) ложится сюда же: фильтр
 * и выборка отделены от страницы, поэтому выгрузка — это тот же listFlowerExpenses с
 * другим размером страницы, а не второй источник правды.
 */
import { Prisma } from "@/generated/prisma/client";
import type { Role } from "@/generated/prisma/enums";
import { prisma } from "@/lib/db";
import { computeDayFinance, dayShareCents } from "./dayCalc";
import { computeDay, computeDayShare, dayKey, gatherDayOrders } from "./dayFinance";
import { recalculateAffectedFinance } from "./fix";

export class FlowerExpenseError extends Error {
  constructor(
    public readonly reason: string,
    message: string
  ) {
    super(message);
    this.name = "FlowerExpenseError";
  }
}

export type ExpenseActor = { userId: string; role: Role; floristId?: string | null };

/** Статус дня в таблице. Порядок — от «нечего делать» к «сделай что-нибудь». */
export type DayStatus = "COUNTED" | "FILLED" | "INCOMPLETE" | "MISSING";

export type FlowerExpenseRow = {
  day: string;
  /** Строка расхода; null — за этот день ничего не внесено. */
  expense: {
    id: string;
    amountCents: number;
    currency: string;
    comment: string | null;
    createdBy: string;
    createdByName: string | null;
    createdAt: Date;
    updatedBy: string | null;
    updatedByName: string | null;
    updatedAt: Date;
  } | null;
  status: DayStatus;
  ordersTotal: number;
  /** День посчитан целиком — только такой даёт заработок. */
  complete: boolean;
  /** Итог дня уже записан: расчёт по этому дню проводился. */
  calculated: boolean;
  distributableCents: number;
  /** Доля флориста за день; null — день не посчитан. */
  shareCents: number | null;
};

export type FlowerExpenseFilter = {
  /** Начало и конец периода включительно. Оба null — вся история. */
  from?: Date | null;
  to?: Date | null;
  /** Поиск по комментарию, регистронезависимый. */
  query?: string | null;
  status?: DayStatus | null;
};

export type FlowerExpenseListResult = {
  rows: FlowerExpenseRow[];
  page: number;
  perPage: number;
  totalDays: number;
  /** Итоги по ВСЕМУ отфильтрованному периоду, а не по странице. */
  totals: {
    expenseCents: number;
    daysFilled: number;
    daysMissing: number;
    averagePerFilledDayCents: number;
  };
};

/** Профиль основного флориста. Единственный источник financeProfileId для владельца. */
export async function activePrimaryProfile(): Promise<{
  id: string;
  floristId: string;
  sharePercentBp: number | null;
  floristName: string;
} | null> {
  const row = await prisma.floristFinanceProfile.findFirst({
    where: { model: "PRIMARY", active: true, effectiveTo: null },
    select: {
      id: true,
      floristId: true,
      sharePercentBp: true,
      florist: { select: { user: { select: { name: true } } } },
    },
  });
  return row ? { id: row.id, floristId: row.floristId, sharePercentBp: row.sharePercentBp, floristName: row.florist.user.name } : null;
}

/**
 * Профиль, с которым актору разрешено работать.
 *
 * Владелец получает действующий PRIMARY. Флорист — свой и только свой, и только если он
 * действительно PRIMARY: у SECONDARY дневных закупок нет, поэтому раздел ему не положен.
 */
export async function resolveProfileFor(actor: ExpenseActor): Promise<{ id: string; floristId: string; floristName: string } | null> {
  if (actor.role === "OWNER") {
    const p = await activePrimaryProfile();
    return p ? { id: p.id, floristId: p.floristId, floristName: p.floristName } : null;
  }
  if (actor.role !== "FLORIST" || !actor.floristId) return null;

  const row = await prisma.floristFinanceProfile.findFirst({
    where: { floristId: actor.floristId, model: "PRIMARY", active: true, effectiveTo: null },
    select: { id: true, floristId: true, florist: { select: { user: { select: { name: true } } } } },
  });
  return row ? { id: row.id, floristId: row.floristId, floristName: row.florist.user.name } : null;
}

function assertCanWrite(actor: ExpenseActor): void {
  if (actor.role !== "OWNER" && actor.role !== "FLORIST") {
    throw new FlowerExpenseError("forbidden", "Раздел доступен владельцу и основному флористу.");
  }
}

function assertAmount(cents: number): void {
  if (!Number.isInteger(cents) || cents < 0) {
    throw new FlowerExpenseError("bad_amount", "Сумма закупки должна быть неотрицательной.");
  }
}

/** UTC-полночь календарного дня. Единственный способ получить expenseDay из строки. */
export function parseDay(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new FlowerExpenseError("bad_day", "Дата должна быть в формате ГГГГ-ММ-ДД.");
  }
  const d = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) throw new FlowerExpenseError("bad_day", "Некорректная дата.");
  return d;
}

// ─────────────────────────── Чтение ───────────────────────────

/**
 * Все дни профиля с фактами и статусом. Ограничения «последние N дней» здесь нет:
 * период задаёт вызывающий, и «вся история» — обычное, а не исключительное значение.
 */
export async function listFlowerExpenses(
  profileId: string,
  floristId: string,
  filter: FlowerExpenseFilter,
  paging: { page: number; perPage: number }
): Promise<FlowerExpenseListResult> {
  const range =
    filter.from || filter.to
      ? { ...(filter.from ? { gte: filter.from } : {}), ...(filter.to ? { lte: filter.to } : {}) }
      : undefined;

  const [expenses, orderDays] = await Promise.all([
    prisma.dailyFlowerExpense.findMany({
      where: {
        financeProfileId: profileId,
        ...(range ? { expenseDay: range } : {}),
        ...(filter.query ? { comment: { contains: filter.query, mode: "insensitive" } } : {}),
      },
      orderBy: { expenseDay: "desc" },
    }),
    // Дни поиска пропусков нужны только когда по комментарию не ищут: у дня без строки
    // комментария нет, и подмешивать его в результаты поиска — значит врать о совпадении.
    filter.query
      ? Promise.resolve([] as { deliveryDate: Date }[])
      : prisma.order.findMany({
          where: {
            currentFloristId: floristId,
            orderStatus: "DELIVERED",
            ...(range ? { deliveryDate: range } : {}),
          },
          select: { deliveryDate: true },
          distinct: ["deliveryDate"],
        }),
  ]);

  const byDay = new Map<string, (typeof expenses)[number] | null>();
  for (const d of orderDays) byDay.set(dayKey(d.deliveryDate), null);
  for (const e of expenses) byDay.set(dayKey(e.expenseDay), e);

  const allDays = [...byDay.keys()].sort((a, b) => (a < b ? 1 : -1));

  // Факты нужны по всем дням периода: итоги вверху страницы считаются по периоду,
  // а не по видимой странице, иначе «дней без заполнения» менялось бы при листании.
  const facts = await dayFacts(profileId, allDays);

  const rows: FlowerExpenseRow[] = allDays.map((day) => {
    const e = byDay.get(day) ?? null;
    const f = facts.get(day)!;
    return {
      day,
      expense: e
        ? {
            id: e.id,
            amountCents: e.amountCents,
            currency: e.currency,
            comment: e.comment,
            createdBy: e.createdBy,
            createdByName: null,
            createdAt: e.createdAt,
            updatedBy: e.updatedBy,
            updatedByName: null,
            updatedAt: e.updatedAt,
          }
        : null,
      status: deriveStatus(e != null, f),
      ...f,
    };
  });

  const filtered = filter.status ? rows.filter((r) => r.status === filter.status) : rows;
  await attachUserNames(filtered);

  const filledRows = filtered.filter((r) => r.expense != null);
  const expenseCents = filledRows.reduce((a, r) => a + r.expense!.amountCents, 0);

  const perPage = Math.max(paging.perPage, 1);
  const page = Math.max(paging.page, 1);
  const start = (page - 1) * perPage;

  return {
    rows: filtered.slice(start, start + perPage),
    page,
    perPage,
    totalDays: filtered.length,
    totals: {
      expenseCents,
      daysFilled: filledRows.length,
      daysMissing: filtered.filter((r) => r.status === "MISSING").length,
      averagePerFilledDayCents: filledRows.length ? Math.round(expenseCents / filledRows.length) : 0,
    },
  };
}

type DayFacts = Pick<FlowerExpenseRow, "ordersTotal" | "complete" | "calculated" | "distributableCents" | "shareCents">;

/**
 * Факты по дням из записанных итогов. Один запрос на весь список, а не по запросу на день.
 *
 * Источник ровно один — строка итога дня. Раньше их было два (снимки заказов и книга
 * операций), и они умели расходиться между собой.
 */
async function dayFacts(profileId: string, days: string[]): Promise<Map<string, DayFacts>> {
  const empty = (): DayFacts => ({
    ordersTotal: 0,
    complete: false,
    calculated: false,
    distributableCents: 0,
    shareCents: null,
  });
  const out = new Map<string, DayFacts>(days.map((d) => [d, empty()]));
  if (days.length === 0) return out;

  const profile = await prisma.floristFinanceProfile.findUnique({
    where: { id: profileId },
    select: { sharePercentBp: true },
  });
  const bp = profile?.sharePercentBp ?? 0;

  const rows = await prisma.dayFinance.findMany({
    where: { financeProfileId: profileId, day: { in: days.map((d) => new Date(`${d}T00:00:00.000Z`)) } },
    select: { day: true, ordersTotal: true, complete: true, distributableCents: true },
  });

  for (const r of rows) {
    const f = out.get(dayKey(r.day));
    if (!f) continue;
    f.calculated = true;
    f.ordersTotal = r.ordersTotal;
    f.complete = r.complete;
    f.distributableCents = r.distributableCents;
    f.shareCents = r.complete ? dayShareCents(r.distributableCents, bp) : null;
  }

  return out;
}

/**
 * Статус дня.
 *
 * «Не посчитан целиком» — это не «что-то не так вообще», а строго: расчёт по дню
 * проводился, но чего-то во входных данных не хватило. День, по которому расчёт ещё не
 * проводился, к этому статусу отношения не имеет: там пока просто нечего проверять.
 */
function deriveStatus(hasExpense: boolean, f: DayFacts): DayStatus {
  if (!hasExpense) return "MISSING";
  // День без доставок считать нечего, и пугать «не хватает данных» здесь не за что.
  if (!f.calculated || f.ordersTotal === 0) return "FILLED";
  return f.complete ? "COUNTED" : "INCOMPLETE";
}

/** Имена авторов подставляются одним запросом, а не join'ом на каждую строку. */
async function attachUserNames(rows: FlowerExpenseRow[]): Promise<void> {
  const ids = new Set<string>();
  for (const r of rows) {
    if (r.expense?.createdBy) ids.add(r.expense.createdBy);
    if (r.expense?.updatedBy) ids.add(r.expense.updatedBy);
  }
  if (ids.size === 0) return;

  const users = await prisma.user.findMany({ where: { id: { in: [...ids] } }, select: { id: true, name: true } });
  const nameById = new Map(users.map((u) => [u.id, u.name]));
  for (const r of rows) {
    if (!r.expense) continue;
    r.expense.createdByName = nameById.get(r.expense.createdBy) ?? null;
    r.expense.updatedByName = r.expense.updatedBy ? (nameById.get(r.expense.updatedBy) ?? null) : null;
  }
}

/** Один день целиком: строка расхода, факты, заказы и история изменений. */
export async function getFlowerExpenseDay(
  profileId: string,
  floristId: string,
  day: Date
): Promise<{
  row: FlowerExpenseRow;
  orders: Array<{ orderId: string; orderNumber: string; contributionCents: number; included: boolean }>;
  history: Array<{ id: string; action: string; beforeJson: unknown; afterJson: unknown; reason: string | null; userName: string | null; role: Role; createdAt: Date }>;
}> {
  const key = dayKey(day);
  const list = await listFlowerExpenses(profileId, floristId, { from: day, to: day }, { page: 1, perPage: 1 });
  const row =
    list.rows[0] ??
    ({
      day: key,
      expense: null,
      status: "MISSING",
      ordersTotal: 0,
      complete: false,
      calculated: false,
      distributableCents: 0,
      shareCents: null,
    } satisfies FlowerExpenseRow);

  // На странице дня факты берутся из ЖИВОГО расчёта, а не из записанного итога: список
  // показывает то, что уже посчитано, а здесь заказы дня перечислены построчно, и итог
  // обязан сходиться с этими строками — даже если пересчёт ещё не проходил.
  const live = await computeDay(profileId, day);
  if (live) {
    row.ordersTotal = live.ordersTotal;
    row.complete = live.complete;
    row.distributableCents = live.distributableCents;
  }

  const orders =
    live?.orders.map((o) => ({
      orderId: o.orderId,
      orderNumber: o.orderNumber,
      contributionCents: o.contributionCents,
      included: o.missing.length === 0,
    })) ?? [];

  // История ведётся по строке расхода. Удалённая строка своей истории не теряет:
  // записи аудита остаются и находятся по прежнему entityId.
  const auditIds = new Set<string>();
  if (row.expense) auditIds.add(row.expense.id);
  const prior = await prisma.financeAudit.findMany({
    where: { entity: "DailyFlowerExpense", afterJson: { path: ["expenseDay"], equals: day.toISOString() } },
    select: { entityId: true },
  });
  for (const p of prior) auditIds.add(p.entityId);

  const audits = auditIds.size
    ? await prisma.financeAudit.findMany({
        where: { entity: "DailyFlowerExpense", entityId: { in: [...auditIds] } },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          action: true,
          beforeJson: true,
          afterJson: true,
          reason: true,
          role: true,
          createdAt: true,
          user: { select: { name: true } },
        },
      })
    : [];

  return {
    row,
    orders,
    history: audits.map((a) => ({
      id: a.id,
      action: a.action,
      beforeJson: a.beforeJson,
      afterJson: a.afterJson,
      reason: a.reason,
      userName: a.user?.name ?? null,
      role: a.role,
      createdAt: a.createdAt,
    })),
  };
}

// ─────────────────────────── Предпросмотр ───────────────────────────

export type ExpensePreview = {
  day: string;
  /** null — расхода за день ещё нет. */
  fromCents: number | null;
  /** null — расход удаляется. */
  toCents: number | null;
  expenseDeltaCents: number;
  /** Доля флориста сейчас и после применения; null — день посчитать нельзя. */
  shareBeforeCents: number | null;
  shareAfterCents: number | null;
  shareDeltaCents: number;
  accruedCents: number | null;
  ordersAffected: number;
  /** День уже посчитан — правка сдвинет заработок флориста. */
  alreadyUsed: boolean;
  warnings: string[];
};

/**
 * Что именно изменится, если применить правку. Ничего не пишет.
 *
 * Считается тем же движком, что и настоящий расчёт: тот же вход дня, только сумма закупки
 * подменена. Предпросмотр, который считает по своей формуле, рано или поздно разойдётся
 * с тем, что произойдёт на самом деле.
 */
export async function previewFlowerExpense(
  profileId: string,
  day: Date,
  nextCents: number | null
): Promise<ExpensePreview> {
  const profile = await prisma.floristFinanceProfile.findUnique({
    where: { id: profileId },
    select: { floristId: true, sharePercentBp: true },
  });
  if (!profile) throw new FlowerExpenseError("no_profile", "Финансовый профиль не найден.");

  const existing = await prisma.dailyFlowerExpense.findUnique({
    where: { financeProfileId_expenseDay: { financeProfileId: profileId, expenseDay: day } },
    select: { amountCents: true },
  });

  const input = await gatherDayOrders(profileId, day);
  if (!input) throw new FlowerExpenseError("no_profile", "Финансовый профиль не найден.");

  const bp = profile.sharePercentBp ?? 0;
  const before = computeDayFinance(input.orders, input.flowerPurchaseCents);
  // Удаление: считать «сколько станет» нечего — день перестаёт быть считаемым.
  const after = nextCents == null ? null : computeDayFinance(input.orders, nextCents);

  // Доля считается ТОЙ ЖЕ функцией, что и в настоящем расчёте. Своя формула здесь рано
  // или поздно разойдётся с фактом: dayShareCents, например, обнуляет долю на убыточном
  // дне, и предпросмотр со своей арифметикой обещал бы отрицательную выплату.
  const shareBefore = before.complete ? dayShareCents(before.distributableCents, bp) : null;
  const shareAfter = after?.complete ? dayShareCents(after.distributableCents, bp) : null;

  const warnings: string[] = [];
  const alreadyUsed = before.complete;

  if (alreadyUsed && shareAfter !== shareBefore) {
    warnings.push("День уже посчитан. Заработок флориста за этот день изменится.");
  }
  if (nextCents == null && alreadyUsed) {
    warnings.push("После удаления день перестанет считаться, и заработок за него обнулится.");
  }
  if (nextCents == null && !alreadyUsed) {
    warnings.push("После удаления день попадёт в «Требует заполнения» как блокирующая проблема.");
  }

  return {
    day: dayKey(day),
    fromCents: existing?.amountCents ?? null,
    toCents: nextCents,
    expenseDeltaCents: (nextCents ?? 0) - (existing?.amountCents ?? 0),
    shareBeforeCents: shareBefore,
    shareAfterCents: shareAfter,
    shareDeltaCents: (shareAfter ?? 0) - (shareBefore ?? 0),
    accruedCents: shareBefore,
    ordersAffected: before.ordersTotal,
    alreadyUsed,
    warnings,
  };
}

// ─────────────────────────── Запись ───────────────────────────

export type ExpenseApplyResult = {
  day: string;
  /** День посчитался целиком после правки. */
  complete: boolean;
  /** Доля флориста за день после правки; null — день не посчитан. */
  shareCents: number | null;
  issuesOpened: number;
};

/**
 * Вносит или исправляет расход за день, затем прогоняет обязательный хвост:
 * аудит → пересчёт итога дня → детектор.
 *
 * Отдельной проверки «изменились ли деньги» здесь нет и быть не должно: заработок
 * выводится из итога дня, поэтому переписать итог — и значит закончить.
 */
export async function saveFlowerExpense(args: {
  actor: ExpenseActor;
  expenseDay: Date;
  amountCents: number;
  comment?: string | null;
  now?: Date;
}): Promise<ExpenseApplyResult> {
  assertCanWrite(args.actor);
  assertAmount(args.amountCents);

  const profile = await resolveProfileFor(args.actor);
  if (!profile) throw new FlowerExpenseError("no_profile", "Нет действующего профиля основного флориста.");

  await prisma.$transaction(async (tx) => {
    const existing = await tx.dailyFlowerExpense.findUnique({
      where: { financeProfileId_expenseDay: { financeProfileId: profile.id, expenseDay: args.expenseDay } },
    });

    const row = existing
      ? await tx.dailyFlowerExpense.update({
          where: { id: existing.id },
          data: {
            amountCents: args.amountCents,
            comment: args.comment ?? null,
            updatedBy: args.actor.userId,
          },
          select: { id: true },
        })
      : await tx.dailyFlowerExpense.create({
          data: {
            financeProfileId: profile.id,
            expenseDay: args.expenseDay,
            amountCents: args.amountCents,
            comment: args.comment ?? null,
            createdBy: args.actor.userId,
          },
          select: { id: true },
        });

    await tx.financeAudit.create({
      data: {
        entity: "DailyFlowerExpense",
        entityId: row.id,
        action: existing ? "UPDATE_DAILY_FLOWER_EXPENSE" : "SET_DAILY_FLOWER_EXPENSE",
        beforeJson: existing ? { amountCents: existing.amountCents, comment: existing.comment } : Prisma.JsonNull,
        afterJson: {
          amountCents: args.amountCents,
          comment: args.comment ?? null,
          expenseDay: args.expenseDay.toISOString(),
        },
        reason: args.comment ?? null,
        userId: args.actor.userId,
        role: args.actor.role,
      },
    });
  });

  return applyAftermath(profile, args.expenseDay, args.actor, args.now ?? new Date());
}

/**
 * Удаляет ошибочную запись.
 *
 * Сторнировать нечего: без расхода день перестаёт считаться, и заработок за него
 * обнуляется сам — он выводится из итога дня, а не хранится отдельной записью.
 */
export async function deleteFlowerExpense(args: {
  actor: ExpenseActor;
  expenseDay: Date;
  reason: string;
  now?: Date;
}): Promise<ExpenseApplyResult> {
  assertCanWrite(args.actor);
  const reason = args.reason.trim();
  if (!reason) throw new FlowerExpenseError("reason_required", "Укажите причину удаления.");

  const profile = await resolveProfileFor(args.actor);
  if (!profile) throw new FlowerExpenseError("no_profile", "Нет действующего профиля основного флориста.");

  const existing = await prisma.dailyFlowerExpense.findUnique({
    where: { financeProfileId_expenseDay: { financeProfileId: profile.id, expenseDay: args.expenseDay } },
  });
  if (!existing) throw new FlowerExpenseError("not_found", "За этот день расход не внесён.");

  await prisma.$transaction(async (tx) => {
    await tx.dailyFlowerExpense.delete({ where: { id: existing.id } });
    await tx.financeAudit.create({
      data: {
        entity: "DailyFlowerExpense",
        entityId: existing.id,
        action: "DELETE_DAILY_FLOWER_EXPENSE",
        beforeJson: { amountCents: existing.amountCents, comment: existing.comment },
        afterJson: { expenseDay: args.expenseDay.toISOString(), deleted: true },
        reason,
        userId: args.actor.userId,
        role: args.actor.role,
      },
    });
  });

  return applyAftermath(profile, args.expenseDay, args.actor, args.now ?? new Date());
}

/**
 * Хвост записи — ОБЩИЙ для всего модуля: пересчёт итога дня → детектор.
 *
 * Собственной копии здесь больше нет. Она была, и это ровно тот случай, когда правишь
 * одно место, а второе продолжает жить по-старому.
 *
 * Пересчёт идёт с ролью OWNER даже когда правку внёс флорист: это шаг владельческого
 * конвейера, а настоящий автор записан в FinanceAudit вместе со своей ролью.
 */
async function applyAftermath(
  profile: { id: string; floristId: string },
  day: Date,
  actor: ExpenseActor,
  now: Date
): Promise<ExpenseApplyResult> {
  const r = await recalculateAffectedFinance(profile.id, [day], { userId: actor.userId, role: "OWNER" }, now);
  const share = await computeDayShare(profile.id, day);
  return {
    day: dayKey(day),
    complete: r.complete > 0,
    shareCents: share?.complete ? share.shareCents : null,
    issuesOpened: r.detector.opened + r.detector.reopened,
  };
}
