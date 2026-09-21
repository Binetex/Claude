import Image from "next/image";
import Link from "next/link";
import { logoutAction } from "@/app/actions/auth";
import { Avatar } from "./Avatar";
import { StoreClock } from "./StoreClock";
import { fmtStoreTime } from "@/lib/tz";
import type { CurrentUser } from "@/lib/auth";
import type { Role } from "@/generated/prisma/enums";
import { SidebarNav } from "./AppShellNav";
import { Button } from "@/components/ui/button";

export type NavItem = {
  href: string;
  label: string;
  /**
   * Дополнительные адреса, на которых пункт считается активным. Нужен там, где страница
   * раздела лежит вне его сегмента: «Настройки» открывают вкладку Burq по адресу
   * /dashboard/burq, и без этого списка подсветка в сайдбаре гасла.
   */
  match?: string[];
};

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
          {/* Только логотип: название уже внутри локапа, подписи рядом ничего не добавляли.
              width/height заданы по реальным пропорциям файла (940×188) — без них строка
              подпрыгивает, пока картинка грузится, а неверные пропорции растянули бы логотип. */}
          <div className="px-5 py-4">
            <Image src="/logo.png" alt="FloreMart" width={940} height={188} priority className="h-7 w-auto" />
          </div>
          <div className="mt-1">
            <SidebarNav nav={nav} variant="sidebar" />
          </div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          {/* Верхняя панель */}
          <header className="sticky top-0 z-10 flex items-center justify-between border-b border-slate-200 bg-white/80 px-4 py-2.5 backdrop-blur">
            <div className="md:hidden">
              <Image src="/logo.png" alt="FloreMart" width={940} height={188} priority className="h-6 w-auto" />
            </div>
            <div className="flex flex-1 items-center justify-end gap-3">
              {/* Время магазина слева от имени и отделено чертой: это не свойство сотрудника,
                  а общий для всех факт, и слипшись с именем читалось бы как «его» время. */}
              <StoreClock initial={fmtStoreTime(new Date(), null)} />
              <div className="hidden h-7 w-px bg-slate-200 sm:block" />
              {/* Вся плашка — ссылка в профиль: аватарку меняют оттуда, и искать отдельный
                  пункт меню ради одного поля никто не станет. */}
              <Link href="/dashboard/profile" className="flex items-center gap-2.5 rounded-lg px-1.5 py-1 hover:bg-slate-100">
                <div className="text-right leading-tight">
                  <div className="text-sm font-medium text-slate-800">{user.name}</div>
                  <div className="text-[11px] text-slate-400">{roleLabel[user.role]}</div>
                </div>
                <Avatar name={user.name} src={user.avatarUrl} />
              </Link>
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
