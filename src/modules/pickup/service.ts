import "server-only";
/**
 * Смена основной точки забора флориста. Общая для владельца (карточка флориста) и самого
 * флориста (его кабинет) — правило одно, меняется только кто имеет право позвать.
 *
 * ВАЖНО: смена основной точки НЕ трогает заказы с уже созданным Burq-черновиком. Она влияет
 * только на будущие: rescheduleFloristWaitingOrders по построению берёт заказы БЕЗ активной
 * доставки. Чтобы поменять точку у конкретного уже созданного заказа, есть переключение
 * внутри заказа (оно пересоздаёт доставку).
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { rescheduleFloristWaitingOrders } from "@/integrations/delivery/burq/scheduleService";

export type SetPrimaryResult =
  | { outcome: "changed"; rescheduled: number }
  | { outcome: "unchanged" }
  | { outcome: "inactive" }
  | { outcome: "not_found" };

export async function setPrimaryPickupLocation(
  prisma: PrismaClient,
  input: { locationId: string; floristId: string }
): Promise<SetPrimaryResult> {
  const loc = await prisma.floristPickupLocation.findUnique({
    where: { id: input.locationId },
    select: { floristId: true, isPrimary: true, isActive: true },
  });
  if (!loc || loc.floristId !== input.floristId) return { outcome: "not_found" };
  if (loc.isPrimary) return { outcome: "unchanged" };
  if (!loc.isActive) return { outcome: "inactive" };

  // Снятие прежней и установка новой — одной транзакцией: partial unique index не допускает
  // двух основных даже на миг между двумя запросами.
  await prisma.$transaction([
    prisma.floristPickupLocation.updateMany({ where: { floristId: input.floristId, isPrimary: true }, data: { isPrimary: false } }),
    prisma.floristPickupLocation.update({ where: { id: input.locationId }, data: { isPrimary: true } }),
  ]);

  let rescheduled = 0;
  try {
    rescheduled = await rescheduleFloristWaitingOrders(prisma, input.floristId);
  } catch (err) {
    // Перепланирование — не причина потерять сохранённый выбор основной точки.
    console.error(`[burq] reschedule after primary pickup change failed (${input.floristId}):`, err instanceof Error ? err.message : String(err));
  }
  return { outcome: "changed", rescheduled };
}
