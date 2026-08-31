import Link from "next/link";
import { prisma } from "@/lib/db";
import { Card } from "@/components/ui/Card";
import { FinanceVisibilityToggle } from "./FinanceVisibilityToggle";
import { PickupLocationsEditor } from "./PickupLocationsEditor";
import { AvailabilityEditor } from "./AvailabilityEditor";
import { ownerSetFloristWeekends, ownerAddFloristDayOff, ownerRemoveFloristDayOff } from "./floristActions";
import { AddFloristForm } from "./AddFloristForm";
import { FloristEditForm } from "./FloristEditForm";
import { FloristAvatar } from "@/components/FloristAvatar";

export const dynamic = "force-dynamic";

export default async function FloristsPage() {

  const florists = await prisma.florist.findMany({
    include: {
      user: true,
      // Основная — первой, дальше по дате создания: список читается сверху вниз.
      pickupLocations: { orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }] },
      _count: { select: { currentOrders: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  return (
    <div className="space-y-6">
      <h1 className="text-lg font-semibold text-slate-900">Флористы и распределение</h1>

      <AddFloristForm />

      <div className="grid gap-4 md:grid-cols-2">
        {florists.map((f) => (
          <Card key={f.id} className="p-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <FloristAvatar name={f.user.name} avatarUrl={f.avatarUrl} size={26} />
                <div className="font-medium text-slate-800">{f.user.name}</div>
              </div>
              <span className={`text-xs ${f.active ? "text-emerald-600" : "text-slate-400"}`}>{f.active ? "активен" : "отключён"}</span>
            </div>
            <div className="mt-1 text-sm text-slate-500">{f.user.email} · {f.user.phone}</div>
            <div className="mt-2 text-sm text-slate-600">Активных заказов: {f._count.currentOrders}</div>
            <FinanceVisibilityToggle floristId={f.id} current={f.financeVisibility} />
            <AvailabilityEditor
              floristId={f.id}
              weekendDays={f.weekendDays}
              daysOff={f.daysOff.map((d) => d.toISOString().slice(0, 10)).sort()}
              actions={{
                setWeekends: ownerSetFloristWeekends,
                addDayOff: ownerAddFloristDayOff,
                removeDayOff: ownerRemoveFloristDayOff,
              }}
            />
            <PickupLocationsEditor
              floristId={f.id}
              locations={f.pickupLocations.map((l) => ({
                id: l.id,
                isPrimary: l.isPrimary,
                locationName: l.locationName,
                contactName: l.contactName,
                contactPhone: l.contactPhone,
                addressLine: l.addressLine,
                apartmentOrSuite: l.apartmentOrSuite,
                city: l.city,
                state: l.state,
                zip: l.zip,
                courierInstructions: l.courierInstructions,
                isActive: l.isActive,
              }))}
            />
            <FloristEditForm florist={{ id: f.id, name: f.user.name, email: f.user.email, phone: f.user.phone, active: f.active, avatarUrl: f.avatarUrl }} />
          </Card>
        ))}
      </div>

      <p className="text-xs text-slate-400">
        Приоритет флористов задаётся у каждого магазина — <Link href="/dashboard/sites" className="text-sky-600 underline">Сайты</Link>, вкладка «Флористы».
        Держать один и тот же редактор в двух местах значит однажды поправить один из них.
      </p>
    </div>
  );
}
