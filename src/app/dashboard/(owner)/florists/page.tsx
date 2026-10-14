import Link from "next/link";
import { prisma } from "@/lib/db";
import { Card } from "@/components/ui/Card";
import { FinanceVisibilityToggle } from "./FinanceVisibilityToggle";
import { WorkStartEditor } from "./WorkStartEditor";
import { BouquetShareEditor } from "./BouquetShareEditor";
import { SameDayUntilEditor } from "./SameDayUntilEditor";
import { TelegramHandleEditor } from "./TelegramHandleEditor";
import { PickupLocationsEditor } from "./PickupLocationsEditor";
import { AvailabilityEditor } from "./AvailabilityEditor";
import { ownerSetFloristWeekends, ownerAddFloristDayOff, ownerRemoveFloristDayOff } from "./floristActions";
import { AddFloristForm } from "./AddFloristForm";
import { FloristEditForm } from "./FloristEditForm";
import { FloristAvatar } from "@/components/FloristAvatar";
import { SitePriorityEditor } from "./SitePriorityEditor";
import { TERMINAL_ORDER_STATUSES } from "@/lib/statuses";

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

  // Очередь всех магазинов — здесь же, рядом с выходными и «Заказами на сегодня»: распределение
  // складывается из всего этого вместе (владелец 14.10.2026: «все настройки выведи»). Редактор тот
  // же, что во вкладке магазина, — один компонент, а не копия.
  const [sites, unassigned] = await Promise.all([
    prisma.site.findMany({
      orderBy: { name: "asc" },
      select: {
        id: true, name: true,
        floristPriorities: { orderBy: { position: "asc" }, select: { floristId: true, position: true, florist: { select: { user: { select: { name: true } } } } } },
      },
    }),
    // Тот же критерий «требуют назначения», что во вкладке магазина.
    prisma.order.groupBy({
      by: ["siteId"],
      where: { assignmentStatus: "UNASSIGNED", paymentStatus: "PAID", orderStatus: { notIn: TERMINAL_ORDER_STATUSES } },
      _count: { _all: true },
    }),
  ]);
  const unassignedBySite = new Map(unassigned.map((u) => [u.siteId, u._count._all]));
  const activeFlorists = florists.filter((f) => f.active && f.user.active).map((f) => ({ id: f.id, name: f.user.name }));

  return (
    <div className="space-y-6">
      <h1 className="text-lg font-semibold text-slate-900">Флористы и распределение</h1>

      <AddFloristForm />

      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-slate-800">Очередь по магазинам</h2>
        <p className="text-xs text-slate-500">
          Новый заказ получает первый в очереди магазина, кто в этот день работает. Выходные и даты
          отпуска — у флориста ниже; заказ на сегодня после часа из «Заказы на сегодня» уходит следующему.
        </p>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {sites.map((site) => (
            <Card key={site.id} className="p-3">
              <div className="mb-2 text-sm font-medium text-slate-800">{site.name}</div>
              <SitePriorityEditor
                siteId={site.id}
                priorities={site.floristPriorities.map((p) => ({ floristId: p.floristId, name: p.florist.user.name, position: p.position }))}
                allFlorists={activeFlorists}
                unassignedCount={unassignedBySite.get(site.id) ?? 0}
              />
            </Card>
          ))}
        </div>
      </section>

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
            <WorkStartEditor floristId={f.id} workStartMin={f.workStartMin} />
            <SameDayUntilEditor floristId={f.id} sameDayUntilMin={f.sameDayUntilMin} />
            <BouquetShareEditor floristId={f.id} sharePercentBp={f.bouquetSharePercentBp} />
            <TelegramHandleEditor floristId={f.id} handle={f.user.telegramId} />
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
        Та же очередь — во вкладке «Приоритет флористов» каждого магазина (<Link href="/dashboard/sites" className="text-sky-600 underline">Магазины</Link>):
        редактор один и тот же, правка видна в обоих местах.
      </p>
    </div>
  );
}
