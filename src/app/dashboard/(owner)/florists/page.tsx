import { prisma } from "@/lib/db";
import { Card, CardHeader, CardTitle, CardBody } from "@/components/ui/Card";
import { FinanceVisibilityToggle } from "./FinanceVisibilityToggle";
import { SitePriorityEditor } from "./SitePriorityEditor";
import { PickupLocationEditor } from "./PickupLocationEditor";
import { TERMINAL_ORDER_STATUSES } from "@/lib/statuses";

export const dynamic = "force-dynamic";

export default async function FloristsPage() {
  const sites = await prisma.site.findMany({
    include: {
      floristPriorities: { orderBy: { position: "asc" }, include: { florist: { include: { user: true } } } },
      // Требуют назначения: оплачены, не назначены и не терминальные (выполнен/отменён).
      _count: {
        select: {
          orders: {
            where: { assignmentStatus: "UNASSIGNED", paymentStatus: "PAID", orderStatus: { notIn: TERMINAL_ORDER_STATUSES } },
          },
        },
      },
    },
    orderBy: { name: "asc" },
  });

  const florists = await prisma.florist.findMany({
    include: { user: true, pickupLocation: true, _count: { select: { currentOrders: true } } },
    orderBy: { createdAt: "asc" },
  });

  return (
    <div className="space-y-6">
      <h1 className="text-lg font-semibold text-slate-900">Флористы и распределение</h1>

      <div className="grid gap-4 md:grid-cols-2">
        {florists.map((f) => (
          <Card key={f.id} className="p-4">
            <div className="flex items-center justify-between">
              <div className="font-medium text-slate-800">{f.user.name}</div>
              <span className={`text-xs ${f.active ? "text-emerald-600" : "text-slate-400"}`}>{f.active ? "активен" : "отключён"}</span>
            </div>
            <div className="mt-1 text-sm text-slate-500">{f.user.email} · {f.user.phone}</div>
            <div className="mt-2 text-sm text-slate-600">Активных заказов: {f._count.currentOrders}</div>
            <FinanceVisibilityToggle floristId={f.id} current={f.financeVisibility} />
            <PickupLocationEditor
              floristId={f.id}
              value={
                f.pickupLocation
                  ? {
                      locationName: f.pickupLocation.locationName,
                      contactName: f.pickupLocation.contactName,
                      contactPhone: f.pickupLocation.contactPhone,
                      addressLine: f.pickupLocation.addressLine,
                      apartmentOrSuite: f.pickupLocation.apartmentOrSuite,
                      city: f.pickupLocation.city,
                      state: f.pickupLocation.state,
                      zip: f.pickupLocation.zip,
                      courierInstructions: f.pickupLocation.courierInstructions,
                      isActive: f.pickupLocation.isActive,
                    }
                  : null
              }
            />
          </Card>
        ))}
      </div>

      <div>
        <h2 className="mb-2 text-sm font-semibold text-slate-700">Приоритеты по сайтам</h2>
        <p className="mb-3 text-xs text-slate-400">
          Для каждого сайта — своя последовательность. Основной флорист (позиция 1) получает заказ первым; при отказе заказ уходит следующему.
        </p>
        <div className="grid gap-4 md:grid-cols-2">
          {sites.map((s) => (
            <Card key={s.id}>
              <CardHeader className="flex items-center gap-2">
                <span className="h-3 w-3 rounded-full" style={{ background: s.colorTag }} />
                <CardTitle>{s.name}</CardTitle>
              </CardHeader>
              <CardBody>
                <SitePriorityEditor
                  siteId={s.id}
                  priorities={s.floristPriorities.map((p) => ({ floristId: p.floristId, name: p.florist.user.name, position: p.position }))}
                  allFlorists={florists.map((f) => ({ id: f.id, name: f.user.name }))}
                  unassignedCount={s._count.orders}
                />
              </CardBody>
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
}
