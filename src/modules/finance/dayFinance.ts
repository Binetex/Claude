import "server-only";
/**
 * Сбор и запись финансового итога дня.
 *
 * Одна строка на (профиль, день), изменяемая: пересчитали — перезаписали. Ревизий и
 * истории расчёта здесь нет, история денег живёт в начислениях и выплатах.
 *
 * Дневная закупка цветов вычитается прямо на уровне дня. Позиции каталога всё ещё нужны,
 * но уже только ради одного — узнать закупочную стоимость ваз и подарков. «Цветочная
 * выручка» как знаменатель распределения исчезла вместе с распределением, и вместе с ней
 * исчез блокер «неопределимая выручка»: неразмеченная позиция больше не останавливает
 * день, если у неё нет закупочной стоимости.
 *
 * Позиции всего дня резолвятся ОДНИМ вызовом, а не по заказу: раньше это был честный N+1,
 * из-за которого сборка дня стоила сотни запросов.
 */
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { toNumber } from "@/lib/money";
import { computeDayFinance, type DayFinanceResult, type DayOrderInput } from "./dayCalc";
import { resolveItemsFinance } from "./itemFinance";
import { estimateFeeCents, resolveConsumablesRate, resolveDailyFlowerExpense, resolveFeeModel } from "./settings";

const toCents = (v: unknown) => Math.round(toNumber(v as never) * 100);

/** UTC-календарный день как строка. deliveryDate — уже UTC-полночь локального дня. */
export function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Собирает вход дня. Ничего не пишет.
 *
 * NULL в расходе означает «неизвестно» и останавливает день. Ноль — это подтверждённое
 * «не платим»; путать их нельзя, иначе прибыль окажется завышенной.
 */
export async function gatherDayOrders(
  profileId: string,
  day: Date
): Promise<{ orders: DayOrderInput[]; flowerPurchaseCents: number | null } | null> {
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
      itemsTotal: true,
      tax: true,
      tip: true,
      deliveryCustomerCost: true,
      deliveryActualCost: true,
      deliveryActualCostConfirmedAt: true,
      customerTotal: true,
      acquiringFee: { select: { feeCents: true } },
      consumablesOverride: { select: { amountCents: true } },
      items: { select: { id: true, name: true, quantity: true, productId: true, variantId: true } },
    },
  });

  const [flowerExpense, additional, itemFinance] = await Promise.all([
    resolveDailyFlowerExpense(profile.id, day),
    // Действующие дополнительные расходы всех заказов дня — одним запросом.
    prisma.orderAdditionalExpense.findMany({
      where: { orderId: { in: orders.map((o) => o.id) }, reversedAt: null },
      select: { orderId: true, amountCents: true },
    }),
    resolveItemsFinance(orders.flatMap((o) => o.items), day),
  ]);

  const additionalByOrder = new Map<string, number>();
  for (const a of additional) {
    additionalByOrder.set(a.orderId, (additionalByOrder.get(a.orderId) ?? 0) + a.amountCents);
  }

  const result: DayOrderInput[] = [];
  for (const order of orders) {
    // Закупка ваз и подарков: если хоть у одной позиции она неизвестна — неизвестна вся
    // сумма, а не «сколько нашли».
    let vaseGiftCostCents: number | null = 0;
    for (const item of order.items) {
      const fin = itemFinance.get(item.id);
      if (!fin || fin.isTip) continue;
      if (fin.costRequired && fin.purchaseCostCents == null) {
        vaseGiftCostCents = null;
        break;
      }
      if (fin.purchaseCostCents != null) {
        vaseGiftCostCents = (vaseGiftCostCents ?? 0) + fin.purchaseCostCents * item.quantity;
      }
    }

    // Подтверждённый ноль — валидная стоимость, неподтверждённый — неизвестность.
    const deliveryCents = toCents(order.deliveryActualCost);
    const deliveryActualCents =
      order.deliveryActualCostConfirmedAt != null || deliveryCents > 0 ? deliveryCents : null;

    // Фактическая комиссия приоритетнее модели магазина.
    const feeModel = order.acquiringFee ? null : await resolveFeeModel(order.siteId, day);
    const acquiringFeeCents = order.acquiringFee
      ? order.acquiringFee.feeCents
      : feeModel
        ? estimateFeeCents(feeModel, toCents(order.customerTotal))
        : null;

    const rate = order.consumablesOverride ? null : await resolveConsumablesRate(order.siteId, day);
    const consumablesCents = order.consumablesOverride ? order.consumablesOverride.amountCents : (rate?.amountCents ?? null);

    result.push({
      orderId: order.id,
      orderNumber: order.orderNumber,
      siteId: order.siteId,
      grossRevenueCents:
        toCents(order.itemsTotal) + toCents(order.tax) + toCents(order.deliveryCustomerCost) + toCents(order.tip),
      tipCents: toCents(order.tip),
      taxCents: toCents(order.tax),
      deliveryActualCents,
      acquiringFeeCents,
      vaseGiftCostCents,
      consumablesCents,
      additionalCents: additionalByOrder.get(order.id) ?? 0,
    });
  }

  return { orders: result, flowerPurchaseCents: flowerExpense?.amountCents ?? null };
}

/** Считает день, ничего не записывая. */
export async function computeDay(profileId: string, day: Date): Promise<DayFinanceResult | null> {
  const input = await gatherDayOrders(profileId, day);
  if (!input) return null;
  return computeDayFinance(input.orders, input.flowerPurchaseCents);
}

/**
 * Пересчитывает день и перезаписывает его строку.
 *
 * Строка одна и изменяемая: «было» нигде не хранится, потому что объяснять историю
 * расчёта не требуется. Что произошло с деньгами — видно по начислениям и выплатам.
 */
export async function recomputeDay(
  profileId: string,
  day: Date,
  actor: { userId: string }
): Promise<DayFinanceResult | null> {
  const result = await computeDay(profileId, day);
  if (!result) return null;

  const data = {
    complete: result.complete,
    blockers: result.blockers,
    ordersTotal: result.ordersTotal,
    grossRevenueCents: result.grossRevenueCents,
    tipsCents: result.tipsCents,
    taxCents: result.taxCents,
    deliveryCents: result.deliveryCents,
    acquiringFeeCents: result.acquiringFeeCents,
    vaseGiftCostCents: result.vaseGiftCostCents,
    consumablesCents: result.consumablesCents,
    flowerPurchaseCents: result.flowerPurchaseCents,
    additionalCents: result.additionalCents,
    distributableCents: result.distributableCents,
    ordersJson: result.orders as unknown as Prisma.InputJsonValue,
    updatedBy: actor.userId,
  };

  await prisma.dayFinance.upsert({
    where: { financeProfileId_day: { financeProfileId: profileId, day } },
    create: { financeProfileId: profileId, day, ...data },
    update: data,
  });

  return result;
}

/** Читает записанный итог дня. Ничего не считает и не пишет. */
export async function readDay(profileId: string, day: Date) {
  return prisma.dayFinance.findUnique({
    where: { financeProfileId_day: { financeProfileId: profileId, day } },
  });
}
