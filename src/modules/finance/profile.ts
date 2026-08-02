import "server-only";
/**
 * Финансовый профиль флориста с датами действия.
 *
 * Зачем даты: модель оплаты меняется во времени, а начисление за июльский заказ обязано
 * считаться по июльским правилам — даже если в августе флориста перевели на другую модель.
 * Поэтому резолв всегда идёт НА ДАТУ (дату доставки заказа), а не «как сейчас».
 *
 * Отсутствие профиля — это НЕ «наверное, SECONDARY». Это «модель не задана», и начисление
 * в таком случае не создаётся: угадывать деньги нельзя.
 */
import { Prisma } from "@/generated/prisma/client";
import type { FinanceModel, FinanceScope, Role } from "@/generated/prisma/enums";
import { prisma } from "@/lib/db";

/** Постгресовое нарушение exclusion-constraint (пересечение периодов действия). */
const EXCLUSION_VIOLATION = "23P01";

export type ResolvedProfile = {
  id: string;
  floristId: string;
  model: FinanceModel;
  sharePercentBp: number | null;
  scope: FinanceScope;
  siteIds: string[];
  effectiveFrom: Date;
  effectiveTo: Date | null;
};

/**
 * Действующий профиль флориста на дату. NULL — профиля нет.
 *
 * Интервал полуоткрытый [from, to): заказ, доставленный ровно в момент смены профиля,
 * попадает в НОВЫЙ период — как и у стоимости ваз.
 */
export async function resolveProfileAt(floristId: string, at: Date): Promise<ResolvedProfile | null> {
  const row = await prisma.floristFinanceProfile.findFirst({
    where: {
      floristId,
      active: true,
      effectiveFrom: { lte: at },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }],
    },
    orderBy: { effectiveFrom: "desc" },
    include: { sites: { select: { siteId: true } } },
  });
  if (!row) return null;
  return {
    id: row.id,
    floristId: row.floristId,
    model: row.model,
    sharePercentBp: row.sharePercentBp,
    scope: row.scope,
    siteIds: row.sites.map((s) => s.siteId),
    effectiveFrom: row.effectiveFrom,
    effectiveTo: row.effectiveTo,
  };
}

/**
 * Распространяется ли профиль на магазин заказа. При ALL_SITES — да всегда;
 * при SELECTED_SITES список магазинов не может быть пустым (проверяется при записи).
 */
export function profileCoversSite(profile: ResolvedProfile, siteId: string): boolean {
  return profile.scope === "ALL_SITES" || profile.siteIds.includes(siteId);
}

/** Текущие профили всех флористов — для списка в разделе «Финансы». */
export async function listCurrentProfiles(at: Date = new Date()): Promise<Map<string, ResolvedProfile>> {
  const rows = await prisma.floristFinanceProfile.findMany({
    where: {
      active: true,
      effectiveFrom: { lte: at },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }],
    },
    orderBy: { effectiveFrom: "desc" },
    include: { sites: { select: { siteId: true } } },
  });
  const map = new Map<string, ResolvedProfile>();
  for (const row of rows) {
    // Пересечения запрещены exclusion-constraint'ом, поэтому на флориста строка ровно одна;
    // orderBy оставлен как страховка на случай ручной правки в БД.
    if (map.has(row.floristId)) continue;
    map.set(row.floristId, {
      id: row.id,
      floristId: row.floristId,
      model: row.model,
      sharePercentBp: row.sharePercentBp,
      scope: row.scope,
      siteIds: row.sites.map((s) => s.siteId),
      effectiveFrom: row.effectiveFrom,
      effectiveTo: row.effectiveTo,
    });
  }
  return map;
}

export class FinanceProfileError extends Error {
  constructor(
    public readonly reason: string,
    message: string
  ) {
    super(message);
    this.name = "FinanceProfileError";
  }
}

export type SetProfileArgs = {
  floristId: string;
  model: FinanceModel;
  /** Доля в базисных пунктах (66.6% = 6660). Только для PRIMARY. */
  sharePercentBp?: number | null;
  scope?: FinanceScope;
  siteIds?: string[];
  effectiveFrom: Date;
  comment?: string | null;
  actor: { userId: string; role: Role };
};

/**
 * Задаёт новый действующий профиль: закрывает текущий и открывает следующий — одной
 * транзакцией, тем же приёмом, что и смена закупочной стоимости вазы.
 *
 * Старый период НЕ переписывается: он остаётся в истории и продолжает объяснять
 * уже созданные по нему начисления.
 */
export async function setFinanceProfile(args: SetProfileArgs): Promise<{ closedId: string | null; createdId: string }> {
  if (args.actor.role !== "OWNER") {
    throw new FinanceProfileError("forbidden", "Финансовый профиль задаёт только владелец.");
  }
  if (args.model === "SECONDARY" && args.sharePercentBp != null) {
    throw new FinanceProfileError("share_on_secondary", "Доля в процентах есть только у основного флориста.");
  }
  if (args.sharePercentBp != null && (!Number.isInteger(args.sharePercentBp) || args.sharePercentBp < 0 || args.sharePercentBp > 10000)) {
    throw new FinanceProfileError("bad_share", "Доля задаётся в базисных пунктах от 0 до 10000 (66.6% = 6660).");
  }
  const scope = args.scope ?? "ALL_SITES";
  const siteIds = scope === "SELECTED_SITES" ? [...new Set(args.siteIds ?? [])] : [];
  if (scope === "SELECTED_SITES" && siteIds.length === 0) {
    throw new FinanceProfileError("no_sites", "Для выбранных магазинов нужно указать хотя бы один магазин.");
  }

  try {
    return await runOnce(args, scope, siteIds);
  } catch (err) {
    // Гонку выигрывает первая транзакция; вторая перечитывает состояние и повторяет —
    // тот же приём, что в setVasePurchaseCost.
    const isExclusion =
      (err instanceof Prisma.PrismaClientKnownRequestError && err.meta?.code === EXCLUSION_VIOLATION) ||
      (err instanceof Prisma.PrismaClientUnknownRequestError && String(err.message).includes(EXCLUSION_VIOLATION));
    if (isExclusion) return await runOnce(args, scope, siteIds);
    throw err;
  }
}

async function runOnce(
  args: SetProfileArgs,
  scope: FinanceScope,
  siteIds: string[]
): Promise<{ closedId: string | null; createdId: string }> {
  return prisma.$transaction(async (tx) => {
    const active = await tx.floristFinanceProfile.findFirst({
      where: { floristId: args.floristId, active: true, effectiveTo: null },
      orderBy: { effectiveFrom: "desc" },
    });

    let closedId: string | null = null;
    if (active) {
      if (active.effectiveFrom.getTime() >= args.effectiveFrom.getTime()) {
        throw new FinanceProfileError(
          "bad_period",
          `Новый профиль должен начинаться позже текущего (текущий действует с ${active.effectiveFrom.toISOString().slice(0, 10)}).`
        );
      }
      await tx.floristFinanceProfile.update({
        where: { id: active.id },
        data: { effectiveTo: args.effectiveFrom },
      });
      closedId = active.id;
    }

    const created = await tx.floristFinanceProfile.create({
      data: {
        floristId: args.floristId,
        model: args.model,
        sharePercentBp: args.sharePercentBp ?? null,
        scope,
        effectiveFrom: args.effectiveFrom,
        comment: args.comment ?? null,
        createdBy: args.actor.userId,
        ...(siteIds.length ? { sites: { create: siteIds.map((siteId) => ({ siteId })) } } : {}),
      },
      select: { id: true },
    });

    const florist = await tx.florist.findUnique({
      where: { id: args.floristId },
      select: { user: { select: { name: true } } },
    });

    await tx.financeAudit.create({
      data: {
        entity: "FloristFinanceProfile",
        entityId: created.id,
        action: "SET_FINANCE_PROFILE",
        beforeJson: active
          ? {
              profileId: active.id,
              model: active.model,
              sharePercentBp: active.sharePercentBp,
              scope: active.scope,
              effectiveFrom: active.effectiveFrom.toISOString(),
            }
          : Prisma.JsonNull,
        afterJson: {
          profileId: created.id,
          model: args.model,
          sharePercentBp: args.sharePercentBp ?? null,
          scope,
          siteIds,
          effectiveFrom: args.effectiveFrom.toISOString(),
        },
        reason: args.comment ?? null,
        entityNameSnapshot: florist?.user.name ?? null,
        userId: args.actor.userId,
        role: args.actor.role,
      },
    });

    return { closedId, createdId: created.id };
  });
}
