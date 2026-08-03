import { requireFlorist } from "@/lib/rbac";
import { prisma } from "@/lib/db";
import { Card, CardHeader, CardTitle, CardBody } from "@/components/ui/Card";
import { PickupChoice } from "./PickupChoice";

/** Вкладка флориста: выбор основной точки забора среди своих. Адреса заводит владелец. */
export const dynamic = "force-dynamic";

export default async function FloristPickupPage() {
  const user = await requireFlorist();
  const locations = await prisma.floristPickupLocation.findMany({
    where: { floristId: user.floristId },
    orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
  });

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold text-slate-900">Мои точки забора</h1>

      <Card>
        <CardHeader>
          <CardTitle>Откуда курьер забирает заказы</CardTitle>
        </CardHeader>
        <CardBody>
          <p className="mb-3 text-sm text-slate-500">
            Основная точка подставляется в НОВЫЕ заказы. Уже созданные доставки она не меняет — если нужно
            поменять точку у конкретного заказа, сделайте это на странице заказа: доставка там пересоздастся.
          </p>
          {locations.length === 0 ? (
            <p className="text-sm text-amber-600">
              Точек пока нет. Пока их не заведёт владелец, доставка по вашим заказам не создаётся.
            </p>
          ) : (
            <PickupChoice
              locations={locations.map((l) => ({
                id: l.id,
                isPrimary: l.isPrimary,
                isActive: l.isActive,
                locationName: l.locationName,
                addressLine: l.addressLine,
                apartmentOrSuite: l.apartmentOrSuite,
                city: l.city,
                state: l.state,
                zip: l.zip,
              }))}
            />
          )}
        </CardBody>
      </Card>
    </div>
  );
}
