import "server-only";
/**
 * Правка сумм РУЧНОГО заказа: налог, чаевые, доставка для заказчика, скидка.
 *
 * Позиции здесь НЕ трогаются (решение владельца): править приходится общую сумму, а цена
 * конкретного букета почти всегда верна. Из-за этого «Сумма товаров» остаётся прежней, а
 * пересчитывается только итог заказчика.
 *
 * ТОЛЬКО заказы, заведённые руками. У заказов из Shopify и WooCommerce суммы приходят с
 * платформы, и ближайшая синхронизация молча вернула бы старые числа — правка выглядела бы
 * применённой ровно до следующего опроса.
 *
 * Итог заказчика — вход дневных финансов (выручка и комиссия эквайринга), поэтому после
 * изменения ОБЯЗАТЕЛЕН пересчёт дня. Без него доля флориста осталась бы посчитанной по старой
 * сумме, а расхождение всплыло бы уже в деньгах.
 */
import { Prisma, type Role } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { recomputeEstimatedProfit } from "@/modules/pricing/service";
import { recomputeDayForOrder } from "@/modules/finance/orderDayHook";

export type ManualCharges = {
  tax: number;
  tip: number;
  discount: number;
  deliveryCustomerCost: number;
};

export type UpdateChargesResult = { ok: true; customerTotal: number } | { ok: false; error: string };

const FIELDS: (keyof ManualCharges)[] = ["tax", "tip", "discount", "deliveryCustomerCost"];

/** Деньги в заказе — Decimal(10,2); всё, что приходит из формы, округляем до цента. */
function money(n: number): Prisma.Decimal {
  return new Prisma.Decimal(n.toFixed(2));
}

export async function updateManualOrderCharges(
  orderId: string,
  input: ManualCharges,
  actor: { userId: string; role: Role }
): Promise<UpdateChargesResult> {
  // Округляем до цента ДО всех расчётов: в базе Decimal(10,2), и без этого записанный итог
  // отличался бы от показанного на копейку при вводе вида «10.005».
  const charges = {} as ManualCharges;
  for (const f of FIELDS) {
    const v = input[f];
    if (!Number.isFinite(v) || v < 0) return { ok: false, error: "Суммы должны быть числами не меньше нуля." };
    charges[f] = Math.round(v * 100) / 100;
  }

  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { source: true, itemsTotal: true, tax: true, tip: true, discount: true, deliveryCustomerCost: true },
  });
  if (!order) return { ok: false, error: "Заказ не найден." };
  if (order.source !== "MANUAL") {
    return { ok: false, error: "Суммы можно править только у заказов, заведённых вручную." };
  }

  const itemsTotal = Number(order.itemsTotal);
  const customerTotal = itemsTotal + charges.tax + charges.tip + charges.deliveryCustomerCost - charges.discount;
  if (customerTotal < 0) return { ok: false, error: "Скидка больше суммы заказа." };

  // Пишем только то, что реально поменялось: аудит должен отвечать на вопрос «что правили»,
  // а не перечислять все поля при каждом сохранении.
  const changed: Record<string, { from: number; to: number }> = {};
  for (const f of FIELDS) {
    const before = Number(order[f]);
    if (before !== charges[f]) changed[f] = { from: before, to: charges[f] };
  }
  const beforeTotal = itemsTotal + Number(order.tax) + Number(order.tip) + Number(order.deliveryCustomerCost) - Number(order.discount);
  if (beforeTotal !== customerTotal) changed.customerTotal = { from: beforeTotal, to: customerTotal };
  if (Object.keys(changed).length === 0) return { ok: true, customerTotal };

  await prisma.$transaction(async (tx) => {
    await tx.order.update({
      where: { id: orderId },
      data: {
        tax: money(charges.tax),
        tip: money(charges.tip),
        discount: money(charges.discount),
        deliveryCustomerCost: money(charges.deliveryCustomerCost),
        customerTotal: money(customerTotal),
      },
    });
    await tx.orderAudit.create({
      data: { orderId, userId: actor.userId, role: actor.role, block: "charges", changed },
    });
    await recomputeEstimatedProfit(tx, orderId);
  });

  // Вне транзакции: пересчёт дня ходит по своим таблицам и не должен держать блокировки заказа.
  await recomputeDayForOrder(prisma, orderId).catch(() => {
    // Финансы не имеют права уронить сохранение сумм — тот же принцип, что у orderDayHook.
  });

  return { ok: true, customerTotal };
}
