import { logoutAction } from "@/app/actions/auth";
import type { CurrentUser } from "@/lib/auth";
import type { Role } from "@/generated/prisma/enums";
import { SidebarNav } from "./AppShellNav";
import { Button } from "@/components/ui/button";

export type NavItem = { href: string; label: string };

const roleLabel: Record<Role, string> = {
  OWNER: "Владелец",
  FLORIST: "Флорист",
  CALL_CENTER: "Колл-центр",
};

export function AppShell({
  user,
  nav,
  children,
}: {
  user: CurrentUser;
  nav: NavItem[];
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <div className="mx-auto flex min-h-screen max-w-[1400px] flex-col md:flex-row">
        {/* Боковая навигация (десктоп) */}
        <aside className="hidden w-60 shrink-0 border-r border-slate-200 bg-white md:flex md:flex-col">
          <div className="flex items-center gap-2 px-5 py-4">
            <span className="text-lg">🌸</span>
            <div className="leading-tight">
              <div className="text-sm font-semibold text-slate-900">Floremart</div>
              <div className="text-[11px] text-slate-400">Дашборд заказов</div>
            </div>
          </div>
          <div className="mt-1">
            <SidebarNav nav={nav} variant="sidebar" />
          </div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          {/* Верхняя панель */}
          <header className="sticky top-0 z-10 flex items-center justify-between border-b border-slate-200 bg-white/80 px-4 py-2.5 backdrop-blur">
            <div className="flex items-center gap-2 md:hidden">
              <span>🌸</span>
              <span className="text-sm font-semibold">Floremart</span>
            </div>
            <div className="flex flex-1 items-center justify-end gap-3">
              <div className="text-right leading-tight">
                <div className="text-sm font-medium text-slate-800">{user.name}</div>
                <div className="text-[11px] text-slate-400">{roleLabel[user.role]}</div>
              </div>
              <form action={logoutAction}>
                <Button type="submit" variant="outline" size="sm">Выйти</Button>
              </form>
            </div>
          </header>

          {/* Нижняя навигация (мобайл) */}
          <SidebarNav nav={nav} variant="mobile" />

          <main className="min-w-0 flex-1 p-4 md:p-6">{children}</main>
        </div>
      </div>
    </div>
  );
}
