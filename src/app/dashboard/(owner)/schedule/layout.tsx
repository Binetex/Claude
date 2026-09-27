import { requireRole } from "@/lib/rbac";
import { ScheduleTabs } from "./ScheduleTabs";

/**
 * «График доставки»: вкладки на каждой странице. Единственная проверка прав раздела — своей у
 * страниц нет.
 */
export default async function ScheduleLayout({ children }: { children: React.ReactNode }) {
  await requireRole("OWNER");
  return (
    <div className="space-y-4">
      <ScheduleTabs />
      {children}
    </div>
  );
}
