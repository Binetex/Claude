import "server-only";
/**
 * Заказы, которые нужно дополнить, чтобы деньги посчитались.
 *
 * Дни в этом списке не участвуют намеренно. День не считается не сам по себе, а потому что в
 * нём есть заказ с незаполненными данными: показывать даты значит заставлять владельца зайти в
 * день, чтобы там узнать заказы, — лишний шаг ради сущности, которую всё равно нельзя починить
 * напрямую. Чинится заказ.
 *
 * Две причины попасть сюда, и они разной природы:
 *  · у заказа не заполнены расходы (доставка, комиссия, ваза, расходники) — тогда не считается
 *    весь его день, и доля основного флориста за этот день не начисляется;
 *  · у заказа второстепенного флориста не задана цена работы — тогда не считается сам заказ.
 *
 * Своей формулы «чего не хватает» здесь нет: используется та же `computeOrderContribution`,
 * что и в расчёте дня. Второй способ ответить на этот вопрос разошёлся бы с первым.
 *
 * ЕДИНСТВЕННЫЙ источник ответа: отсюда читают обзор флористов, разбор дня и детектор
 * очереди «Требует заполнения». Что все трое называют одни и те же заказы, закреплено
 * incompleteConsistency.integration.test.ts.
 */
import { prisma } from "@/lib/db";
import { computeOrderContribution, type MissingInput } from "./dayCalc";
import { toDayOrderInputs } from "./orderInput";
import { resolveItemsFinance } from "./itemFinance";
import { loadFinanceSettings } from "./settingsBatch";
import { accrualGate } from "./config";

export type IncompleteOrder = {
  id: string;
  orderNumber: string;
  deliveryDate: string;
  floristName: string | null;
  /** Незаполненные расходы. Пусто у заказов, которые ждут только цену флориста. */
  missing: MissingInput[];
  /** Не задана цена работы второстепенного флориста. */
  noFloristPrice: boolean;
};

export type IncompleteScope = {
  from: Date;
  to: Date;
  /** Ограничить одним флористом: детектор смотрит только основного — доля считается по его дням. */
  floristId?: string;
};

/**
 * Ядро без политики: какие заказы области не дают посчитать деньги. Гейты и границы области —
 * ответственность вызывающего: разбор дня читает без гейта (его баннер готовности не гейтится),
 * публичный список — через accrualGate, детектор — своё окно и primaryShareGate. Формула
 * пробелов при этом одна на всех. ВНИМАНИЕ: в проде даты обоих гейтов совпадают (2026-08-01);
 * если их развести, гейтнутые потребители разойдутся по краю периода — единая граница по виду
 * пробела возможна, но это решение владельца (см. CLAUDE.md, «Один ответ»).
 */
export async function collectIncompleteOrders(scope: IncompleteScope): Promise<IncompleteOrder[]> {
  const orders = await prisma.order.findMany({
    where: {
      orderStatus: "DELIVERED",
      deliveryDate: { gte: scope.from, lte: scope.to },
      ...(scope.floristId ? { currentFloristId: scope.floristId } : {}),
    },
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
      floristTotal: true,
      acquiringFee: { select: { feeCents: true } },
      consumablesOverride: { select: { amountCents: true } },
      currentFlorist: { select: { id: true, user: { select: { name: true } } } },
      items: {
        select: {
          id: true, name: true, quantity: true, productId: true, variantId: true,
          financialTypeSnapshot: true, purchaseCostSnapshotCents: true,
        },
      },
    },
    orderBy: { deliveryDate: "asc" },
  });
  if (orders.length === 0) return [];

  const siteIds = [...new Set(orders.map((o) => o.siteId))];
  const [additional, itemFinance, settings] = await Promise.all([
    prisma.orderAdditionalExpense.findMany({
      where: { orderId: { in: orders.map((o) => o.id) }, reversedAt: null },
      select: { orderId: true, amountCents: true },
    }),
    resolveItemsFinance(orders.flatMap((o) => o.items)),
    loadFinanceSettings(siteIds),
  ]);

  const additionalByOrder = new Map<string, number>();
  for (const a of additional) {
    additionalByOrder.set(a.orderId, (additionalByOrder.get(a.orderId) ?? 0) + a.amountCents);
  }

  // taxShareBp не передаётся: налог не рождает пробелов (missing выводится из четырёх
  // nullable-расходов, см. dayCalc), а вклад заказа ядро не использует.
  const inputs = toDayOrderInputs(orders, { additionalByOrder, itemFinance, settings });
  const missingByOrder = new Map(inputs.map((i) => [i.orderId, computeOrderContribution(i).missing]));

  // Модель оплаты флориста определяет, что считать пробелом: у второстепенного цена работы
  // задаётся вручную, и ноль означает «не задана», а не «делаем бесплатно».
  const secondaryIds = new Set(
    (
      await prisma.floristFinanceProfile.findMany({
        where: { model: "SECONDARY", active: true, effectiveTo: null },
        select: { floristId: true },
      })
    ).map((p) => p.floristId)
  );

  const out: IncompleteOrder[] = [];
  for (const o of orders) {
    const missing = missingByOrder.get(o.id) ?? [];
    const noFloristPrice =
      !!o.currentFlorist && secondaryIds.has(o.currentFlorist.id) && Number(o.floristTotal ?? 0) === 0;
    if (missing.length === 0 && !noFloristPrice) continue;

    out.push({
      id: o.id,
      orderNumber: o.orderNumber,
      deliveryDate: o.deliveryDate.toISOString().slice(0, 10),
      floristName: o.currentFlorist?.user.name ?? null,
      missing,
      noFloristPrice,
    });
  }
  return out;
}

/** Публичный список «что дополнить»: всё доставленное в периоде, не раньше гейта начислений. */
export async function listIncompleteOrders(from: Date, to: Date): Promise<IncompleteOrder[]> {
  const gate = accrualGate();
  if (!gate.enabled) return [];
  return collectIncompleteOrders({ from: from > gate.startDate ? from : gate.startDate, to });
}
