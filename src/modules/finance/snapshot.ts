import "server-only";
/**
 * Сборка и публикация финансовых снимков заказа.
 *
 * Снимок отвечает на вопрос «почему за этот день начислено столько» через год, когда
 * каталог и настройки уже другие. Поэтому в `calcInputJson` уходит ВЕСЬ вход: суммы,
 * позиции с классификацией, вазы и их закупка, применённая ставка расходников, модель
 * комиссии с её id, доставка, налоговая политика, дневная закупка со знаменателем
 * распределения и причины, по которым заказ не попал в расчёт.
 *
 * Публикация: новая ревизия создаётся DRAFT, затем прежняя PUBLISHED переводится в
 * SUPERSEDED, а новая — в PUBLISHED. Всё в одной транзакции, поэтому состояния «две
 * действующие ревизии» не существует (плюс частичный unique-индекс в БД).
 */
import { Prisma } from "@/generated/prisma/client";
import type { FinancialItemType, Role } from "@/generated/prisma/enums";
import { prisma } from "@/lib/db";
import { toNumber } from "@/lib/money";
import { isTipItem } from "@/modules/pricing/serviceItems";
import { effectiveFinancialType, resolveVariantFinance, type VaseCostRow } from "@/modules/catalog/finance/resolveVariantFinance";
import { computeDay, type DayCalcResult, type OrderCalcInput, type SnapshotItem } from "./calc";
import { estimateFeeCents, resolveConsumablesRate, resolveDailyFlowerExpense, resolveFeeModel, resolveOwnerTaxPolicy } from "./settings";

const toCents = (v: unknown) => Math.round(toNumber(v as never) * 100);

/** UTC-календарный день как строка. deliveryDate — уже UTC-полночь локального дня. */
export function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export type OrderInputMeta = {
  orderId: string;
  orderNumber: string;
  siteId: string;
  siteShortName: string;
  /** Ссылки на применённые настройки — уходят в calcInputJson. */
  refs: {
    consumablesRateId: string | null;
    consumablesSource: "RATE" | "OVERRIDE" | null;
    feeModelId: string | null;
    feeSource: "ACTUAL" | "ESTIMATED" | null;
    ownerTaxPolicyId: string | null;
    ownerTaxShareBp: number | null;
    vaseCostRecordIds: string[];
  };
  /** Позиции в человекочитаемом виде для объяснимости расчёта. */
  items: Array<{
    id: string;
    name: string;
    quantity: number;
    unitPriceCents: number;
    financialType: string | null;
    isTip: boolean;
    purchaseCostCents: number | null;
    catalogReasons: string[];
  }>;
};

export type DayInputs = {
  profileId: string;
  floristId: string;
  day: Date;
  dailyExpense: { id: string; amountCents: number } | null;
  orders: OrderCalcInput[];
  meta: Map<string, OrderInputMeta>;
};

/**
 * Собирает всё, что нужно для расчёта одного дня одного профиля.
 * Ничего не пишет и ничего не решает — только читает и нормализует.
 */
export async function gatherDayInputs(profileId: string, day: Date): Promise<DayInputs | null> {
  const profile = await prisma.floristFinanceProfile.findUnique({
    where: { id: profileId },
    select: { id: true, floristId: true, model: true },
  });
  if (!profile || profile.model !== "PRIMARY") return null;

  const orders = await prisma.order.findMany({
    where: { currentFloristId: profile.floristId, orderStatus: "DELIVERED", deliveryDate: day },
    select: {
      id: true,
      orderNumber: true,
      siteId: true,
      deliveryDate: true,
      itemsTotal: true,
      tax: true,
      tip: true,
      deliveryCustomerCost: true,
      deliveryActualCost: true,
      deliveryActualCostConfirmedAt: true,
      customerTotal: true,
      site: { select: { shortName: true } },
      acquiringFee: { select: { feeCents: true } },
      consumablesOverride: { select: { amountCents: true } },
      items: {
        select: {
          id: true,
          name: true,
          quantity: true,
          productId: true,
          variantId: true,
          externalPrice: true,
        },
      },
    },
  });

  const dailyExpense = await resolveDailyFlowerExpense(profile.id, day);
  const calcInputs: OrderCalcInput[] = [];
  const meta = new Map<string, OrderInputMeta>();

  for (const order of orders) {
    const itemFinance = await resolveItemsFinance(order.items, day);

    const items: SnapshotItem[] = order.items.map((i) => {
      const fin = itemFinance.get(i.id)!;
      return {
        id: i.id,
        name: i.name,
        quantity: i.quantity,
        unitPriceCents: toCents(i.externalPrice),
        financialType: fin.financialType,
        isTip: fin.isTip,
      };
    });

    // Закупка ваз и подарков: сумма по позициям, у которых она применима.
    // Если хоть у одной она неизвестна — вся сумма неизвестна, а не «сколько нашли».
    let vaseGiftCostCents: number | null = 0;
    const vaseCostRecordIds: string[] = [];
    for (const i of order.items) {
      const fin = itemFinance.get(i.id)!;
      if (fin.isTip) continue;
      if (fin.costRequired && fin.purchaseCostCents == null) {
        vaseGiftCostCents = null;
        break;
      }
      if (fin.purchaseCostCents != null) {
        vaseGiftCostCents = (vaseGiftCostCents ?? 0) + fin.purchaseCostCents * i.quantity;
        if (fin.purchaseCostRecordId) vaseCostRecordIds.push(fin.purchaseCostRecordId);
      }
    }

    // Доставка: подтверждённый ноль — валидная стоимость, неподтверждённый — неизвестность.
    const deliveryCents = toCents(order.deliveryActualCost);
    const deliveryActualCents =
      order.deliveryActualCostConfirmedAt != null || deliveryCents > 0 ? deliveryCents : null;

    // Комиссия: фактическая приоритетнее модели.
    const customerPaidCents = toCents(order.customerTotal);
    const feeModel = order.acquiringFee ? null : await resolveFeeModel(order.siteId, day);
    const acquiringFee = order.acquiringFee
      ? { cents: order.acquiringFee.feeCents, source: "ACTUAL" as const, modelId: null }
      : feeModel
        ? { cents: estimateFeeCents(feeModel, customerPaidCents), source: "ESTIMATED" as const, modelId: feeModel.modelId }
        : null;

    const rate = order.consumablesOverride ? null : await resolveConsumablesRate(order.siteId, day);
    const consumables = order.consumablesOverride
      ? { cents: order.consumablesOverride.amountCents, source: "OVERRIDE" as const, rateId: null }
      : rate
        ? { cents: rate.amountCents, source: "RATE" as const, rateId: rate.rateId }
        : null;

    const taxPolicy = await resolveOwnerTaxPolicy(order.siteId, day);

    calcInputs.push({
      orderId: order.id,
      orderNumber: order.orderNumber,
      siteId: order.siteId,
      deliveryDay: dayKey(order.deliveryDate),
      itemsTotalCents: toCents(order.itemsTotal),
      taxCents: toCents(order.tax),
      tipCents: toCents(order.tip),
      deliveryCustomerCents: toCents(order.deliveryCustomerCost),
      customerPaidCents,
      items,
      deliveryActualCents,
      acquiringFee,
      vaseGiftCostCents,
      consumables,
      otherExpenseCents: 0,
    });

    meta.set(order.id, {
      orderId: order.id,
      orderNumber: order.orderNumber,
      siteId: order.siteId,
      siteShortName: order.site.shortName,
      refs: {
        consumablesRateId: consumables?.rateId ?? null,
        consumablesSource: consumables?.source ?? null,
        feeModelId: acquiringFee?.modelId ?? null,
        feeSource: acquiringFee?.source ?? null,
        ownerTaxPolicyId: taxPolicy?.policyId ?? null,
        ownerTaxShareBp: taxPolicy?.actualShareBp ?? null,
        vaseCostRecordIds,
      },
      items: order.items.map((i) => {
        const fin = itemFinance.get(i.id)!;
        return {
          id: i.id,
          name: i.name,
          quantity: i.quantity,
          unitPriceCents: toCents(i.externalPrice),
          financialType: fin.financialType,
          isTip: fin.isTip,
          purchaseCostCents: fin.purchaseCostCents,
          catalogReasons: fin.reasons,
        };
      }),
    });
  }

  return { profileId: profile.id, floristId: profile.floristId, day, dailyExpense, orders: calcInputs, meta };
}

type ItemFinance = {
  isTip: boolean;
  financialType: FinancialItemType | null;
  /** Позиции этого типа обязаны иметь закупочную стоимость. */
  costRequired: boolean;
  purchaseCostCents: number | null;
  purchaseCostRecordId: string | null;
  reasons: string[];
};

/**
 * Классификация и закупочная стоимость позиций заказа на дату доставки.
 * Резолв целиком делегирован Stage 1 (`resolveVariantFinance`) — второй формулы нет.
 */
async function resolveItemsFinance(
  items: Array<{ id: string; name: string; productId: string | null; variantId: string | null }>,
  at: Date
): Promise<Map<string, ItemFinance>> {
  const result = new Map<string, ItemFinance>();

  const variantIds = [...new Set(items.map((i) => i.variantId).filter((x): x is string => !!x))];
  const productIds = [...new Set(items.map((i) => i.productId).filter((x): x is string => !!x))];

  const variants = variantIds.length
    ? await prisma.productVariant.findMany({
        where: { id: { in: variantIds } },
        select: {
          id: true,
          productId: true,
          title: true,
          financialType: true,
          includesVase: true,
          includedVaseVariantId: true,
          remoteDeleted: true,
          product: {
            select: { id: true, name: true, financialType: true, defaultIncludesVase: true, defaultIncludedVaseVariantId: true },
          },
        },
      })
    : [];

  const products = productIds.length
    ? await prisma.product.findMany({
        where: { id: { in: productIds } },
        select: { id: true, financialType: true, defaultIncludesVase: true, defaultIncludedVaseVariantId: true },
      })
    : [];
  const productById = new Map(products.map((p) => [p.id, p]));

  // Связанные вазы: их тип и собственная закупка нужны для букетов «с вазой».
  const linkedVaseIds = [
    ...new Set(
      variants.flatMap((v) => [v.includedVaseVariantId, v.product.defaultIncludedVaseVariantId].filter((x): x is string => !!x))
    ),
  ];
  const linkedVases = linkedVaseIds.length
    ? await prisma.productVariant.findMany({
        where: { id: { in: linkedVaseIds } },
        select: {
          id: true,
          productId: true,
          title: true,
          remoteDeleted: true,
          financialType: true,
          product: { select: { name: true, financialType: true } },
        },
      })
    : [];

  const costTargets = [...new Set([...variantIds, ...linkedVaseIds])];
  // ТОВАРЫ связанных ваз обязаны попасть в выборку: стоимость вазы часто задана на карточке
  // товара, а не на конкретном варианте, и резолв Stage 1 ищет её именно там
  // (`pick(r.productId === linked.productId)`). Без них у букета с вазой стоимость выглядела
  // бы отсутствующей, хотя она задана, и заказ молча выпадал бы из расчёта.
  const costProductIds = [...new Set([...productIds, ...linkedVases.map((v) => v.productId)])];
  const costs = costTargets.length || costProductIds.length
    ? await prisma.vasePurchaseCost.findMany({
        where: { OR: [{ productVariantId: { in: costTargets } }, { productId: { in: costProductIds } }] },
        select: {
          id: true,
          productId: true,
          productVariantId: true,
          costType: true,
          purchaseCostCents: true,
          effectiveFrom: true,
          effectiveTo: true,
        },
      })
    : [];

  const vaseInfo: Record<string, { id: string; productId: string; effectiveType: typeof linkedVases[number]["financialType"]; archived: boolean; label: string }> = {};
  for (const v of linkedVases) {
    vaseInfo[v.id] = {
      id: v.id,
      productId: v.productId,
      effectiveType: v.financialType ?? v.product.financialType,
      archived: v.remoteDeleted,
      label: `${v.product.name} — ${v.title}`,
    };
  }

  for (const item of items) {
    if (isTipItem(item)) {
      result.set(item.id, { isTip: true, financialType: null, costRequired: false, purchaseCostCents: null, purchaseCostRecordId: null, reasons: [] });
      continue;
    }

    const variant = item.variantId ? variants.find((v) => v.id === item.variantId) : undefined;
    if (variant) {
      const finance = resolveVariantFinance({
        variant: {
          id: variant.id,
          financialType: variant.financialType,
          includesVase: variant.includesVase,
          includedVaseVariantId: variant.includedVaseVariantId,
        },
        product: {
          id: variant.product.id,
          financialType: variant.product.financialType,
          defaultIncludesVase: variant.product.defaultIncludesVase,
          defaultIncludedVaseVariantId: variant.product.defaultIncludedVaseVariantId,
        },
        costs: costs as VaseCostRow[],
        vases: vaseInfo,
        at,
      });
      // Закупка обязательна там, где позиция не является обычным букетом без вазы:
      // именно эти случаи Stage 1 помечает причинами разбора.
      result.set(item.id, {
        isTip: false,
        financialType: finance.financialType,
        costRequired: finance.reviewReasons.length > 0 || finance.purchaseCostCents != null,
        purchaseCostCents: finance.purchaseCostCents,
        purchaseCostRecordId: finance.purchaseCostRecordId,
        reasons: finance.reviewReasons,
      });
      continue;
    }

    const product = item.productId ? productById.get(item.productId) : undefined;
    if (product) {
      result.set(item.id, {
        isTip: false,
        financialType: effectiveFinancialType(null, product.financialType),
        costRequired: false,
        purchaseCostCents: null,
        purchaseCostRecordId: null,
        reasons: [],
      });
      continue;
    }

    // Ни варианта, ни товара: чем является позиция — неизвестно. Знаменатель дня
    // становится недостоверным, и это отдельная блокирующая проблема.
    result.set(item.id, {
      isTip: false,
      financialType: null,
      costRequired: false,
      purchaseCostCents: null,
      purchaseCostRecordId: null,
      reasons: ["ITEM_NOT_IN_CATALOG"],
    });
  }

  return result;
}

export type DayPlan = { inputs: DayInputs; result: DayCalcResult };

/**
 * Кандидатские значения для предпросмотра. Применяются К УЖЕ СОБРАННОМУ входу и никуда
 * не записываются: предпросмотр обязан считать тем же кодом, что и публикация, иначе
 * показанное владельцу число разойдётся с тем, что запишется.
 */
export type CalcOverrides = {
  dailyExpenseCents?: number;
  deliveryActualCentsByOrder?: Record<string, number>;
  feeModelBySite?: Record<string, { percentBp: number; fixedCents: number }>;
  consumablesCentsBySite?: Record<string, number>;
  vaseGiftCostCentsByOrder?: Record<string, number>;
  /**
   * Магазины, где настройки на этот день НЕТ вовсе. Отдельно от подмены значения:
   * «ставка другая» и «ставки не существует» — разные исходы, и второй нельзя выразить
   * числом. Нужен предпросмотру удаления, иначе он показал бы, что ничего не меняется,
   * ровно в том случае, когда заказы выпадают из расчёта целиком.
   */
  feeModelMissingSites?: string[];
  consumablesMissingSites?: string[];
};

function applyOverrides(inputs: DayInputs, o: CalcOverrides): DayInputs {
  if (Object.keys(o).length === 0) return inputs;
  const orders = inputs.orders.map((order) => {
    const next = { ...order };
    const delivery = o.deliveryActualCentsByOrder?.[order.orderId];
    if (delivery != null) next.deliveryActualCents = delivery;

    const feeModel = o.feeModelBySite?.[order.siteId];
    if (feeModel != null && order.acquiringFee?.source !== "ACTUAL") {
      next.acquiringFee = {
        cents: Math.round((order.customerPaidCents * feeModel.percentBp) / 10000) + feeModel.fixedCents,
        source: "ESTIMATED",
        modelId: null,
      };
    }

    const consumables = o.consumablesCentsBySite?.[order.siteId];
    if (consumables != null && order.consumables?.source !== "OVERRIDE") {
      next.consumables = { cents: consumables, source: "RATE", rateId: null };
    }

    // Отсутствие настройки перебивает подмену значения: если её на этот день нет,
    // подставлять нечего, и заказ обязан выпасть из расчёта.
    if (o.feeModelMissingSites?.includes(order.siteId) && order.acquiringFee?.source !== "ACTUAL") {
      next.acquiringFee = null;
    }
    if (o.consumablesMissingSites?.includes(order.siteId) && order.consumables?.source !== "OVERRIDE") {
      next.consumables = null;
    }

    const vaseGift = o.vaseGiftCostCentsByOrder?.[order.orderId];
    if (vaseGift != null) next.vaseGiftCostCents = vaseGift;

    return next;
  });
  return { ...inputs, orders };
}

/**
 * Считает день, ничего не записывая. Используется и предпросмотром, и публикацией,
 * и детектором проблем — расчёт в проекте один.
 */
export async function buildDayPlan(
  profileId: string,
  day: Date,
  overrides: CalcOverrides = {}
): Promise<DayPlan | null> {
  const gathered = await gatherDayInputs(profileId, day);
  if (!gathered) return null;
  const inputs = applyOverrides(gathered, overrides);
  const expense = overrides.dailyExpenseCents ?? inputs.dailyExpense?.amountCents ?? null;
  const result = computeDay(dayKey(day), inputs.orders, expense);
  return { inputs, result };
}

/**
 * Публикует снимки дня новой ревизией. Прежняя действующая ревизия становится
 * SUPERSEDED, но не меняется ни в одном поле — это гарантирует и триггер в БД.
 *
 * Возвращает число опубликованных ревизий. Заказы, у которых расчёт не изменился,
 * пропускаются: плодить ревизии без изменений незачем.
 */
export async function publishDaySnapshots(
  profileId: string,
  day: Date,
  actor: { userId: string; role: Role }
): Promise<{ published: number; skipped: number }> {
  if (actor.role !== "OWNER") throw new Error("снимки публикует только владелец");

  const plan = await buildDayPlan(profileId, day);
  if (!plan) return { published: 0, skipped: 0 };

  let published = 0;
  let skipped = 0;

  for (const computed of plan.result.orders) {
    const meta = plan.inputs.meta.get(computed.orderId)!;
    const input = plan.inputs.orders.find((o) => o.orderId === computed.orderId)!;

    const calcInputJson: Prisma.InputJsonValue = {
      version: 1,
      order: {
        id: input.orderId,
        number: input.orderNumber,
        siteId: input.siteId,
        siteShortName: meta.siteShortName,
        deliveryDay: input.deliveryDay,
        itemsTotalCents: input.itemsTotalCents,
        taxCents: input.taxCents,
        tipCents: input.tipCents,
        deliveryCustomerCents: input.deliveryCustomerCents,
      },
      items: meta.items,
      costs: {
        deliveryActualCents: input.deliveryActualCents,
        acquiringFee: input.acquiringFee,
        vaseGiftCostCents: input.vaseGiftCostCents,
        consumables: input.consumables,
        otherExpenseCents: input.otherExpenseCents,
      },
      day: {
        deliveryDay: plan.result.deliveryDay,
        dailyExpenseId: plan.inputs.dailyExpense?.id ?? null,
        dailyExpenseCents: plan.result.dailyExpenseCents,
        denominatorCents: plan.result.denominatorCents,
        allocatedToThisOrderCents: computed.allocatedFlowerCents,
        blockers: plan.result.blockers,
      },
      settings: meta.refs,
      needsReview: computed.missing,
      computedAt: new Date().toISOString(),
    };

    const changed = await publishOne(computed.orderId, computed, calcInputJson, actor.userId);
    if (changed) published++;
    else skipped++;
  }

  return { published, skipped };
}

async function publishOne(
  orderId: string,
  computed: DayCalcResult["orders"][number],
  calcInputJson: Prisma.InputJsonValue,
  userId: string
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const current = await tx.orderFinancialSnapshot.findFirst({
      where: { orderId, status: "PUBLISHED" },
    });

    // Ничего не изменилось — новая ревизия только замусорила бы историю.
    // grossRevenueCents и tipsCents сравниваются наравне с итогом: они на распределяемую
    // прибыль не влияют, но если снимок останется со старым представлением, экран расчёта
    // и сохранённая ревизия покажут разные суммы выручки — а объяснять расчёт должна
    // именно ревизия.
    if (
      current &&
      current.isCalculable === computed.isCalculable &&
      current.distributableCents === computed.distributableCents &&
      current.grossRevenueCents === computed.grossRevenueCents &&
      current.tipsCents === computed.tipsCents &&
      current.allocatedFlowerCents === computed.allocatedFlowerCents &&
      current.acquiringFeeCents === computed.acquiringFeeCents &&
      current.consumablesCents === computed.consumablesCents &&
      current.vaseGiftCostCents === computed.vaseGiftCostCents &&
      current.deliveryActualCents === computed.deliveryActualCents
    ) {
      return false;
    }

    const last = await tx.orderFinancialSnapshot.findFirst({
      where: { orderId },
      orderBy: { revision: "desc" },
      select: { revision: true },
    });

    if (current) {
      await tx.orderFinancialSnapshot.update({ where: { id: current.id }, data: { status: "SUPERSEDED" } });
    }

    await tx.orderFinancialSnapshot.create({
      data: {
        orderId,
        revision: (last?.revision ?? 0) + 1,
        status: "PUBLISHED",
        isCalculable: computed.isCalculable,
        grossRevenueCents: computed.grossRevenueCents,
        tipsCents: computed.tipsCents,
        flowerRevenueCents: computed.flowerRevenueCents,
        taxCents: computed.taxCents,
        deliveryActualCents: computed.deliveryActualCents,
        acquiringFeeCents: computed.acquiringFeeCents,
        acquiringFeeSource: computed.acquiringFeeSource,
        vaseGiftCostCents: computed.vaseGiftCostCents,
        consumablesCents: computed.consumablesCents,
        allocatedFlowerCents: computed.allocatedFlowerCents,
        otherExpenseCents: computed.otherExpenseCents,
        distributableCents: computed.distributableCents,
        calcInputJson,
        createdBy: userId,
      },
    });

    return true;
  });
}

/** Действующая ревизия снимка заказа — для карточки заказа и отчётов. */
export async function getPublishedSnapshot(orderId: string) {
  return prisma.orderFinancialSnapshot.findFirst({ where: { orderId, status: "PUBLISHED" } });
}

/** Все ревизии заказа, новые сверху — история расчёта. */
export async function listSnapshotRevisions(orderId: string) {
  return prisma.orderFinancialSnapshot.findMany({ where: { orderId }, orderBy: { revision: "desc" } });
}
