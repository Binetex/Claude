import Link from "next/link";
import { requireRole } from "@/lib/rbac";
import { prisma } from "@/lib/db";
import { PageHeader } from "@/components/ui/misc";
import { ManualOrderForm } from "@/components/orders/manual/ManualOrderForm";
import { loadWindowPresets } from "@/modules/orders/windowPresets";

export const dynamic = "force-dynamic";

/**
 * Ручной заказ у колл-центра (владелец 15.10.2026: «создавать заказ кастомный вручную для Севинч»).
 * Тот же экран, что у владельца, без денег флориста: их по каталогу ставит сервер.
 */
export default async function CallCenterNewOrderPage() {
  await requireRole("CALL_CENTER");

  const [sites, florists] = await Promise.all([
    prisma.site.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.florist.findMany({
      where: { active: true },
      select: { id: true, user: { select: { name: true } } },
      orderBy: { createdAt: "asc" },
    }),
  ]);
  const presets = Object.fromEntries(
    await Promise.all(sites.map(async (s) => [s.id, await loadWindowPresets(prisma, s.id).catch(() => [])] as const))
  );

  return (
    <div className="space-y-4">
      <PageHeader
        title="Создать заказ"
        description="Заказ, оформленный не через сайт: по телефону, лично или переносом из другого источника."
        actions={
          <Link href="/dashboard/cc" className="text-sm text-slate-500 hover:text-slate-900">
            К списку заказов
          </Link>
        }
      />
      <ManualOrderForm
        sites={sites}
        windowPresets={presets}
        florists={florists.map((f) => ({ id: f.id, name: f.user.name }))}
        floristMoney={false}
        orderBasePath="/dashboard/cc"
      />
    </div>
  );
}
