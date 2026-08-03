import "server-only";
/**
 * Ежедневное начисление доли основного флориста.
 *
 * Модель простая и намеренно одноуровневая: один тип записи, одна дата запуска, никакого
 * «предварительного» и «официального» начисления. Ledger не двигает реальные деньги — он
 * показывает рассчитанный долг. Реальная выплата появляется ТОЛЬКО ручной операцией
 * PAYMENT от владельца, поэтому расчёт можно спокойно гонять на боевых данных, ничего
 * при этом не выплачивая.
 *
 * Баланс = начисления + бонусы − удержания − выплаты ± корректировки (см. foldBalance).
 *
 * Исправление входных данных не редактирует опубликованную запись: создаётся сторно и
 * новое начисление, баланс меняется сам. Историю переписывать нельзя ничем.
 */
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { appendEntry, type LedgerActor } from "./ledger";
import { reversalKey } from "./ledgerRules";
import { primaryShareCents } from "./calc";
import { buildDayPlan, dayKey, publishDaySnapshots } from "./snapshot";
import { primaryShareGate } from "./config";

/** Ключ дневного начисления. Формат — часть контракта с БД, менять нельзя. */
export function primaryShareKey(floristId: string, day: string): string {
  return `PRIMARY_DAILY_SHARE:${floristId}:${day}:v1`;
}

/** Ключ повторного начисления после сторно — привязан к сторнированной записи. */
export function primaryReshareKey(floristId: string, day: string, reversedEntryId: string): string {
  return `PRIMARY_DAILY_SHARE:${floristId}:${day}:after:${reversedEntryId}`;
}

export type ShareSkipReason =
  | "NOT_STARTED"
  | "BEFORE_START_DATE"
  | "NO_PROFILE"
  | "NO_SHARE_PERCENT"
  | "DAY_BLOCKED"
  | "NO_ORDERS"
  | "ZERO_SHARE";

export type ShareOutcome =
  | { status: "CREATED"; entryId: string; amountCents: number }
  | { status: "UNCHANGED"; amountCents: number }
  | { status: "CORRECTED"; reversalEntryId: string; newEntryId: string | null; fromCents: number; toCents: number }
  | { status: "SKIPPED"; reason: ShareSkipReason };

export type DayShareComputation = {
  day: string;
  distributableCents: number;
  shareCents: number;
  sharePercentBp: number;
  ordersTotal: number;
  ordersCalculable: number;
  blocked: boolean;
  /** Ревизии снимков, из которых собрана сумма. */
  snapshotIds: string[];
};

/**
 * Считает долю за день, ничего не записывая. NULL — профиль не найден.
 *
 * День с блокерами не считается вовсе: посчитать «сколько получится» по неполным данным
 * значило бы показать флористу сумму, которая завтра изменится без его участия.
 */
export async function computeDayShare(profileId: string, day: Date): Promise<DayShareComputation | null> {
  const profile = await prisma.floristFinanceProfile.findUnique({
    where: { id: profileId },
    select: { id: true, floristId: true, model: true, sharePercentBp: true },
  });
  if (!profile || profile.model !== "PRIMARY") return null;

  const plan = await buildDayPlan(profileId, day);
  if (!plan) return null;

  const blocked = plan.result.blockers.length > 0;
  const bp = profile.sharePercentBp ?? 0;
  const distributableCents = plan.result.distributableTotalCents;

  // Ссылаемся на ДЕЙСТВУЮЩИЕ ревизии снимков просчитанных заказов.
  const calculableOrderIds = plan.result.orders.filter((o) => o.isCalculable).map((o) => o.orderId);
  const snapshots = calculableOrderIds.length
    ? await prisma.orderFinancialSnapshot.findMany({
        where: { orderId: { in: calculableOrderIds }, status: "PUBLISHED" },
        select: { id: true },
      })
    : [];

  return {
    day: dayKey(day),
    distributableCents,
    shareCents: blocked ? 0 : primaryShareCents(distributableCents, bp),
    sharePercentBp: bp,
    ordersTotal: plan.result.orders.length,
    ordersCalculable: calculableOrderIds.length,
    blocked,
    snapshotIds: snapshots.map((s) => s.id),
  };
}

/**
 * Начисляет долю за день. Идемпотентно по ключу дня: повторный проход воркера, ручной
 * запуск владельцем и пересчёт после исправления дают одну запись, а не три.
 *
 * Если сумма изменилась — сторно прежней записи и новое начисление в ОДНОЙ транзакции:
 * состояния «сторнировали, но не начислили» существовать не должно.
 */
export async function accrueDayShare(profileId: string, day: Date, actor: LedgerActor): Promise<ShareOutcome> {
  const gate = primaryShareGate();
  if (!gate.enabled) return { status: "SKIPPED", reason: "NOT_STARTED" };
  if (day < gate.startDate) return { status: "SKIPPED", reason: "BEFORE_START_DATE" };

  const profile = await prisma.floristFinanceProfile.findUnique({
    where: { id: profileId },
    select: { id: true, floristId: true, model: true, sharePercentBp: true, florist: { select: { user: { select: { name: true } } } } },
  });
  if (!profile || profile.model !== "PRIMARY") return { status: "SKIPPED", reason: "NO_PROFILE" };
  // Без процента считать нечего, и подставлять его «по умолчанию» нельзя: это деньги.
  if (profile.sharePercentBp == null) return { status: "SKIPPED", reason: "NO_SHARE_PERCENT" };

  let computed = await computeDayShare(profileId, day);
  if (!computed) return { status: "SKIPPED", reason: "NO_PROFILE" };
  if (computed.ordersTotal === 0) return { status: "SKIPPED", reason: "NO_ORDERS" };
  if (computed.blocked) return { status: "SKIPPED", reason: "DAY_BLOCKED" };

  const existing = await prisma.ledgerEntry.findFirst({
    where: { floristId: profile.floristId, type: "PRIMARY_FLORIST_SHARE", effectiveDate: day, reversal: null },
    orderBy: { createdAt: "desc" },
  });

  /**
   * Ключ дня одноразовый: книга append-only, и сторнированная запись из неё никуда не
   * девается вместе со своим ключом. Поэтому день, начисление за который уже сторновали
   * целиком (входные данные удалили, а потом вернули), нельзя начислить снова под тем же
   * ключом — упрёмся в unique. Такое начисление привязывается к сторнированной записи,
   * ровно как при уточнении суммы.
   */
  const reversedLast = existing
    ? null
    : await prisma.ledgerEntry.findFirst({
        where: {
          floristId: profile.floristId,
          type: "PRIMARY_FLORIST_SHARE",
          effectiveDate: day,
          reversal: { isNot: null },
        },
        orderBy: { createdAt: "desc" },
        select: { id: true },
      });
  const key = reversedLast
    ? primaryReshareKey(profile.floristId, computed.day, reversedLast.id)
    : primaryShareKey(profile.floristId, computed.day);

  if (existing && existing.amountCents === computed.shareCents) {
    return { status: "UNCHANGED", amountCents: computed.shareCents };
  }

  /**
   * Сумма меняется — значит, СНАЧАЛА публикуем снимки дня, и только потом пишем в книгу.
   *
   * Иначе запись ссылается на ревизии, которые её не объясняют: именно так и случилось на
   * проде, когда диспетчер поправил деньги за 2 августа, а снимки остались от прежнего
   * состава дня. Владельцу пришлось жать «Пересчитать день» руками.
   *
   * Публикация стоит здесь, а не в начале: на пути «ничего не изменилось» — а это
   * подавляющее большинство проходов диспетчера — она не нужна и стоила бы сборки плана
   * на каждый день каждые 15 минут.
   */
  // Публикация — системный шаг конвейера, поэтому идёт с ролью владельца независимо
  // от того, чья правка запустила пересчёт.
  await publishDaySnapshots(profileId, day, { userId: actor.userId, role: "OWNER" });
  computed = (await computeDayShare(profileId, day))!;
  if (computed.blocked) return { status: "SKIPPED", reason: "DAY_BLOCKED" };

  // Ничего не начислено и начислять нечего — не заводим запись на ноль: «за этот день
  // ноль» и «день ещё не считался» должны различаться.
  if (!existing && computed.shareCents === 0) return { status: "SKIPPED", reason: "ZERO_SHARE" };

  const description = `Доля за ${computed.day}`;
  const metadata: Prisma.InputJsonValue = {
    day: computed.day,
    sharePercentBp: computed.sharePercentBp,
    distributableCents: computed.distributableCents,
    ordersTotal: computed.ordersTotal,
    ordersCalculable: computed.ordersCalculable,
  };

  if (!existing) {
    const created = await prisma.$transaction(async (tx) => {
      const entry = await appendEntry(
        {
          floristId: profile.floristId,
          type: "PRIMARY_FLORIST_SHARE",
          amountCents: computed.shareCents,
          effectiveDate: day,
          description,
          sourceType: "PERIOD",
          sourceId: computed.day,
          idempotencyKey: key,
          metadata,
          actor,
        },
        tx
      );
      await linkSnapshots(tx, entry.id, computed.snapshotIds);
      return entry;
    });
    return { status: "CREATED", entryId: created.id, amountCents: computed.shareCents };
  }

  // Сумма изменилась: сторно + новое начисление. Опубликованную запись не трогаем.
  return prisma.$transaction(async (tx) => {
    const reversal = await appendEntry(
      {
        floristId: profile.floristId,
        type: "CORRECTION",
        direction: "DEBIT",
        amountCents: existing.amountCents,
        effectiveDate: day,
        description: `Сторно доли за ${computed.day}`,
        comment: "Изменились входные данные расчёта",
        sourceType: "REVERSAL",
        sourceId: existing.id,
        idempotencyKey: reversalKey(existing.id),
        reversedEntryId: existing.id,
        actor,
      },
      tx
    );

    let newEntryId: string | null = null;
    if (computed.shareCents > 0) {
      const created = await appendEntry(
        {
          floristId: profile.floristId,
          type: "PRIMARY_FLORIST_SHARE",
          amountCents: computed.shareCents,
          effectiveDate: day,
          description: `${description} (уточнено)`,
          comment: "Пересчёт после исправления входных данных",
          sourceType: "PERIOD",
          sourceId: computed.day,
          idempotencyKey: primaryReshareKey(profile.floristId, computed.day, reversal.id),
          metadata: { ...metadata, correctedFromCents: existing.amountCents },
          actor,
        },
        tx
      );
      await linkSnapshots(tx, created.id, computed.snapshotIds);
      newEntryId = created.id;
    }

    return {
      status: "CORRECTED" as const,
      reversalEntryId: reversal.id,
      newEntryId,
      fromCents: existing.amountCents,
      toCents: computed.shareCents,
    };
  });
}

async function linkSnapshots(tx: Prisma.TransactionClient, ledgerEntryId: string, snapshotIds: string[]): Promise<void> {
  if (snapshotIds.length === 0) return;
  await tx.ledgerEntrySnapshot.createMany({
    data: snapshotIds.map((snapshotId) => ({ ledgerEntryId, snapshotId })),
    skipDuplicates: true,
  });
}

/**
 * Дни, по которым нужно посчитать или пересчитать долю: с даты запуска и по сегодня.
 * Ограничение по датам — единственное; «уже начислено» отсекает сам accrueDayShare,
 * потому что решение «сумма не изменилась» требует полного расчёта.
 */
export async function primaryShareDays(now: Date = new Date()): Promise<{ profileId: string; days: Date[] } | null> {
  const gate = primaryShareGate();
  if (!gate.enabled) return null;

  const profile = await prisma.floristFinanceProfile.findFirst({
    where: { model: "PRIMARY", active: true, effectiveTo: null },
    select: { id: true, floristId: true, sharePercentBp: true },
  });
  if (!profile || profile.sharePercentBp == null) return null;

  const rows = await prisma.order.findMany({
    where: {
      currentFloristId: profile.floristId,
      orderStatus: "DELIVERED",
      deliveryDate: { gte: gate.startDate, lte: now },
    },
    select: { deliveryDate: true },
    distinct: ["deliveryDate"],
    orderBy: { deliveryDate: "asc" },
  });

  return { profileId: profile.id, days: rows.map((r) => r.deliveryDate) };
}

/**
 * Пересчитывает долю по перечисленным дням. Используется и воркером, и исправлениями.
 *
 * Возвращает не только счётчики, но и сами исходы: вызывающему часто нужно «было → стало»
 * по конкретному дню, и добывать это отдельным запросом к книге значило бы спросить у
 * системы то, что она только что сама и посчитала.
 */
export async function accrueDays(profileId: string, days: Date[], actor: LedgerActor) {
  const result = { created: 0, corrected: 0, unchanged: 0, skipped: 0 };
  const outcomes: { day: Date; outcome: ShareOutcome }[] = [];
  for (const day of days) {
    const outcome = await accrueDayShare(profileId, day, actor);
    outcomes.push({ day, outcome });
    if (outcome.status === "CREATED") result.created++;
    else if (outcome.status === "CORRECTED") result.corrected++;
    else if (outcome.status === "UNCHANGED") result.unchanged++;
    else result.skipped++;
  }
  return { ...result, outcomes };
}
