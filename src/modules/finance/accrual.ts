import "server-only";
/**
 * Начисление флористу за доставленный заказ.
 *
 * Идемпотентность — на ключе `SECONDARY_ORDER_ACCRUAL:{orderId}:{floristId}:v1`, поэтому
 * повторный вебхук, resync, повторный проход воркера и ручной запуск владельцем дают
 * одну и ту же единственную запись.
 *
 * Начисление НЕ является «системным пользователем»: автор записи — владелец, от имени
 * которого настроен модуль (в фоновом режиме — единственный активный OWNER). Аноним в
 * финансовой книге недопустим: у каждой суммы должен быть тот, кого можно спросить.
 */
import { prisma } from "@/lib/db";
import { toNumber } from "@/lib/money";
import { appendEntry, type LedgerActor } from "./ledger";
import { orderAccrualKey, orderReaccrualKey, reversalKey } from "./ledgerRules";
import { assessAccrual } from "./accrualRules";
import { resolveProfileAt, profileCoversSite } from "./profile";
import { accrualGate } from "./config";

export type AccrualOutcome =
  | { status: "CREATED"; entryId: string; amountCents: number }
  | { status: "ALREADY_EXISTS"; entryId: string }
  | { status: "SKIPPED"; reason: AccrualSkipReason };

export type AccrualSkipReason =
  | "ACCRUAL_DISABLED"
  | "BEFORE_START_DATE"
  | "ORDER_NOT_FOUND"
  | "NOT_DELIVERED"
  | "NO_FLORIST"
  | "NO_FINANCE_PROFILE"
  | "PRIMARY_MODEL_STAGE3"
  | "PROFILE_SITE_MISMATCH"
  | "FLORIST_PRICE_MISSING";

const ORDER_SELECT = {
  id: true,
  orderNumber: true,
  siteId: true,
  orderStatus: true,
  deliveryDate: true,
  currentFloristId: true,
  priceMode: true,
  floristTotal: true,
  items: { select: { name: true, productId: true, variantId: true, floristItemPrice: true } },
} as const;

/**
 * Начисляет за один заказ. Все проверки — здесь, вызывающие (событие, sweep, кнопка
 * владельца) отличаются только тем, КОГДА вызвали.
 */
export async function accrueOrder(orderId: string, actor: LedgerActor): Promise<AccrualOutcome> {
  const gate = accrualGate();
  if (!gate.enabled) return { status: "SKIPPED", reason: "ACCRUAL_DISABLED" };

  const order = await prisma.order.findUnique({ where: { id: orderId }, select: ORDER_SELECT });
  if (!order) return { status: "SKIPPED", reason: "ORDER_NOT_FOUND" };
  if (order.orderStatus !== "DELIVERED") return { status: "SKIPPED", reason: "NOT_DELIVERED" };
  if (order.deliveryDate < gate.startDate) return { status: "SKIPPED", reason: "BEFORE_START_DATE" };
  if (!order.currentFloristId) return { status: "SKIPPED", reason: "NO_FLORIST" };

  // Профиль резолвится на ДАТУ ДОСТАВКИ, а не на сегодня: перевод флориста на другую
  // модель в августе не должен менять правила для июльского заказа.
  const profile = await resolveProfileAt(order.currentFloristId, order.deliveryDate);
  if (!profile) return { status: "SKIPPED", reason: "NO_FINANCE_PROFILE" };
  if (profile.model === "PRIMARY") return { status: "SKIPPED", reason: "PRIMARY_MODEL_STAGE3" };
  if (!profileCoversSite(profile, order.siteId)) return { status: "SKIPPED", reason: "PROFILE_SITE_MISMATCH" };

  const assessment = assessAccrual({
    priceMode: order.priceMode,
    floristTotal: toNumber(order.floristTotal),
    items: order.items.map((i) => ({ ...i, floristItemPrice: toNumber(i.floristItemPrice) })),
  });
  if (assessment.status !== "OK") return { status: "SKIPPED", reason: "FLORIST_PRICE_MISSING" };

  const result = await appendEntry({
    floristId: order.currentFloristId,
    type: "ORDER_ACCRUAL",
    amountCents: assessment.amountCents,
    effectiveDate: order.deliveryDate,
    description: `Заказ ${order.orderNumber}`,
    orderId: order.id,
    sourceType: "ORDER",
    sourceId: order.id,
    idempotencyKey: orderAccrualKey(order.id, order.currentFloristId),
    metadata: { provenance: assessment.provenance, priceMode: order.priceMode, profileId: profile.id },
    actor,
  });

  return result.created
    ? { status: "CREATED", entryId: result.id, amountCents: assessment.amountCents }
    : { status: "ALREADY_EXISTS", entryId: result.id };
}

export type ReaccrualOutcome =
  | { status: "NO_ACCRUAL" }
  | { status: "UNCHANGED"; amountCents: number }
  | { status: "CORRECTED"; reversalEntryId: string; newEntryId: string | null; fromCents: number; toCents: number };

/**
 * Пересчёт после того, как владелец изменил цену флориста или переназначил уже
 * ДОСТАВЛЕННЫЙ заказ.
 *
 * Опубликованная запись не редактируется никогда (её и нельзя отредактировать — триггер
 * в БД). Вместо этого: сторно старого начисления + новое начисление. В книге остаются обе
 * операции и объяснение, поэтому «почему сумма изменилась» видно через год.
 *
 * Всё в одной транзакции: состояния «сторнировали, но не начислили» существовать не должно.
 */
export async function reaccrueOrder(
  orderId: string,
  actor: LedgerActor,
  reason: string
): Promise<ReaccrualOutcome> {
  const order = await prisma.order.findUnique({ where: { id: orderId }, select: ORDER_SELECT });
  if (!order) return { status: "NO_ACCRUAL" };

  // Живые (не отменённые) начисления по заказу — их может быть больше одного, если заказ
  // переназначали: у каждого флориста свой ключ.
  const accruals = await prisma.ledgerEntry.findMany({
    where: { orderId, type: "ORDER_ACCRUAL", reversal: null },
    select: { id: true, floristId: true, amountCents: true },
  });
  if (accruals.length === 0) return { status: "NO_ACCRUAL" };

  const assessment = assessAccrual({
    priceMode: order.priceMode,
    floristTotal: toNumber(order.floristTotal),
    items: order.items.map((i) => ({ ...i, floristItemPrice: toNumber(i.floristItemPrice) })),
  });
  const newAmount = assessment.status === "OK" ? assessment.amountCents : 0;
  const newFloristId = order.currentFloristId;

  // Ничего не изменилось — не плодим шум в книге.
  const single = accruals.length === 1 ? accruals[0] : null;
  if (single && single.floristId === newFloristId && single.amountCents === newAmount) {
    return { status: "UNCHANGED", amountCents: newAmount };
  }

  return prisma.$transaction(async (tx) => {
    let lastReversalId = "";
    let fromCents = 0;
    for (const accrual of accruals) {
      fromCents += accrual.amountCents;
      const reversal = await appendEntry(
        {
          floristId: accrual.floristId,
          type: "CORRECTION",
          direction: "DEBIT",
          amountCents: accrual.amountCents,
          effectiveDate: order.deliveryDate,
          description: `Сторно начисления по заказу ${order.orderNumber}`,
          comment: reason,
          orderId: order.id,
          sourceType: "REVERSAL",
          sourceId: accrual.id,
          idempotencyKey: reversalKey(accrual.id),
          reversedEntryId: accrual.id,
          actor,
        },
        tx
      );
      lastReversalId = reversal.id;
    }

    // Новое начисление создаётся, только если есть кому и за что: цена может оказаться
    // не задана, а флорист — снят. Тогда заказ штатно уходит в очередь на разбор.
    let newEntryId: string | null = null;
    if (newFloristId && newAmount > 0) {
      const created = await appendEntry(
        {
          floristId: newFloristId,
          type: "ORDER_ACCRUAL",
          amountCents: newAmount,
          effectiveDate: order.deliveryDate,
          description: `Заказ ${order.orderNumber} (уточнённая сумма)`,
          comment: reason,
          orderId: order.id,
          sourceType: "ORDER",
          sourceId: order.id,
          idempotencyKey: orderReaccrualKey(order.id, newFloristId, lastReversalId),
          metadata: {
            provenance: assessment.provenance,
            priceMode: order.priceMode,
            correctedFromCents: fromCents,
          },
          actor,
        },
        tx
      );
      newEntryId = created.id;
    }

    return { status: "CORRECTED", reversalEntryId: lastReversalId, newEntryId, fromCents, toCents: newAmount };
  });
}

/**
 * Владелец, от имени которого выполняются фоновые начисления. Единственный активный OWNER;
 * если их несколько — берём самого раннего, чтобы автор был стабилен между запусками.
 */
export async function backgroundActor(): Promise<LedgerActor | null> {
  const owner = await prisma.user.findFirst({
    where: { role: "OWNER", active: true },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  return owner ? { userId: owner.id, role: "OWNER" } : null;
}
