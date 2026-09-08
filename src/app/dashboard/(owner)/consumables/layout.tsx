import { requireRole } from "@/lib/rbac";
import { ConsumablesTabs } from "./ConsumablesTabs";

/**
 * Обвязка раздела «Расходники»: вкладки на каждой странице.
 *
 * Это ЕДИНСТВЕННАЯ проверка прав для страниц раздела — своей они не имеют. Выносить страницу
 * из-под этого layout нельзя, не добавив requireRole в неё саму.
 */
export default async function ConsumablesLayout({ children }: { children: React.ReactNode }) {
  await requireRole("OWNER");
  return (
    <div className="space-y-4">
      <ConsumablesTabs />
      {children}
    </div>
  );
}
