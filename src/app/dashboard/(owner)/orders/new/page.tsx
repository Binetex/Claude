import Link from "next/link";
import { requireRole } from "@/lib/rbac";
import { prisma } from "@/lib/db";
import { PageHeader } from "@/components/ui/misc";
import { ManualOrderForm } from "./ManualOrderForm";
import { loadWindowPresets } from "@/modules/orders/windowPresets";

export const dynamic = "force-dynamic";

/**
 * Ручное создание заказа владельцем. Обычная страница, а не мастер: три блока на одном
 * экране — позиции, получатель и доставка, флорист и итог.
 */
export default async function NewOrderPage() {
  await requireRole("OWNER");

  const [sites, florists] = await Promise.all([
    prisma.site.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.florist.findMany({
      where: { active: true },
      select: { id: true, user: { select: { name: true } } },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  // Частые окна каждого магазина — кнопки в выборе времени доставки.
  const presets = Object.fromEntries(
    await Promise.all(sites.map(async (s) => [s.id, await loadWindowPresets(prisma, s.id).catch(() => [])] as const))
  );

  return (
    <div className="space-y-4">
      <PageHeader
        title="Создать заказ"
        description="Заказ, оформленный не через сайт: по телефону, лично или переносом из другого источника."
        actions={
          <Link href="/dashboard/orders" className="text-sm text-slate-500 hover:text-slate-900">
            К списку заказов
          </Link>
        }
      />
      <ManualOrderForm
        sites={sites}
        windowPresets={presets}
        florists={florists.map((f) => ({ id: f.id, name: f.user.name }))}
      />
    </div>
  );
}
