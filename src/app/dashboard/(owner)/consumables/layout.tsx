import { Suspense } from "react";
import { requireRole } from "@/lib/rbac";
import { prisma } from "@/lib/db";
import { ConsumablesTabs } from "./ConsumablesTabs";
import { FloristSwitcher } from "./FloristSwitcher";

/**
 * Обвязка раздела «Расходники»: вкладки на каждой странице.
 *
 * Это ЕДИНСТВЕННАЯ проверка прав для страниц раздела — своей они не имеют. Выносить страницу
 * из-под этого layout нельзя, не добавив requireRole в неё саму.
 */
export default async function ConsumablesLayout({ children }: { children: React.ReactNode }) {
  await requireRole("OWNER");
  const florists = await prisma.florist.findMany({
    where: { active: true, user: { active: true } },
    select: { id: true, user: { select: { name: true } } },
    orderBy: { user: { name: "asc" } },
  });
  return (
    <div className="space-y-4">
      {/* Адрес читают оба на клиенте (`useSearchParams`): без Suspense страница не отрисуется статически. */}
      <Suspense>
        <ConsumablesTabs />
        <FloristSwitcher florists={florists.map((f) => ({ id: f.id, name: f.user.name ?? "Флорист" }))} />
      </Suspense>
      {children}
    </div>
  );
}
