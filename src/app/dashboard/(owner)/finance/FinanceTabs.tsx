"use client";
/**
 * Вкладки раздела «Финансы».
 *
 * Боковое меню плоское и одноуровневое, поэтому подстраницы раздела в него не помещаются:
 * держать там пять финансовых пунктов вперемешку с заказами и товарами — значит утопить
 * и то и другое. Вместо этого в меню один пункт, а перемещение внутри раздела здесь.
 *
 * Активная вкладка определяется по префиксу пути, поэтому вложенные страницы (снимок
 * заказа, массовое подтверждение доставки) подсвечивают свой раздел, а не теряют его.
 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/cn";

export type FinanceTab = {
  href: string;
  label: string;
  /** Число рядом с названием: сколько требует внимания. Ноль не показывается. */
  badge?: number;
  /** Красный бейдж вместо нейтрального — что-то блокирует расчёт. */
  alarming?: boolean;
};

function isActive(pathname: string, href: string, tabs: FinanceTab[]): boolean {
  if (pathname === href) return true;
  if (!pathname.startsWith(href + "/")) return false;
  // У вложенных путей выигрывает самая длинная подходящая вкладка: иначе «/setup/delivery»
  // подсветил бы и «/setup», и себя.
  const longest = tabs
    .filter((t) => pathname === t.href || pathname.startsWith(t.href + "/"))
    .reduce((a, b) => (a.href.length >= b.href.length ? a : b));
  return longest.href === href;
}

export function FinanceTabs({ tabs }: { tabs: FinanceTab[] }) {
  const pathname = usePathname();

  return (
    <nav className="flex gap-1 overflow-x-auto border-b border-slate-200 pb-px">
      {tabs.map((tab) => {
        const active = isActive(pathname, tab.href, tabs);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            className={cn(
              "flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition-colors",
              active
                ? "border-slate-900 text-slate-900"
                : "border-transparent text-slate-500 hover:border-slate-200 hover:text-slate-800"
            )}
          >
            {tab.label}
            {tab.badge != null && tab.badge > 0 && (
              <span
                className={cn(
                  "rounded-full px-1.5 py-0.5 text-[11px] leading-none font-semibold",
                  tab.alarming ? "bg-red-100 text-red-700" : "bg-slate-100 text-slate-600"
                )}
              >
                {tab.badge}
              </span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}
