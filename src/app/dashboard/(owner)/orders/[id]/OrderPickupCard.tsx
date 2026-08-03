import { prisma } from "@/lib/db";
import { resolvePickupForOrder } from "@/integrations/delivery/burq/pickupResolution";
import { OrderPickupSwitcher } from "./OrderPickupSwitcher";

/**
 * Блок «Точка забора» на странице заказа. Один и тот же у владельца и у флориста: правило
 * выбора точки общее (resolvePickupForOrder), а переключать её вправе любой сотрудник.
 *
 * Данные грузит сам, чтобы обе страницы заказа не повторяли один и тот же запрос.
 */
export async function OrderPickupCard({ orderId }: { orderId: string }) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      currentFloristId: true,
      pickupLocationOverrideId: true,
      currentFlorist: { select: { pickupLocations: { orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }] } } },
      deliveries: { where: { isCurrentAttempt: true, externalDeliveryId: { not: null } }, select: { id: true } },
    },
  });
  if (!order) return null;

  const pickups = order.currentFlorist?.pickupLocations ?? [];
  const resolved = resolvePickupForOrder({ overrideId: order.pickupLocationOverrideId, floristPickups: pickups });

  return (
    <OrderPickupSwitcher
      data={{
        orderId,
        options: pickups
          .filter((p) => p.isActive)
          .map((p) => ({ id: p.id, locationName: p.locationName, addressLine: p.addressLine, city: p.city, state: p.state, zip: p.zip })),
        currentId: resolved?.location.id ?? null,
        isOverride: resolved?.source === "ORDER_OVERRIDE",
        noFlorist: !order.currentFloristId,
        hasActiveDelivery: order.deliveries.length > 0,
      }}
    />
  );
}
