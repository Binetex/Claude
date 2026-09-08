"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  ClipboardList,
  Store,
  Package,
  Flower2,
  Headphones,
  Wallet,
  ShoppingBasket,
  MapPin,
  Printer,
  Zap,
  Star,
  Receipt,
  Settings,
  Circle,
} from "lucide-react";
import { cn } from "@/lib/cn";
import type { NavItem } from "./AppShell";

function iconFor(href: string) {
  if (href.endsWith("/cc")) return Headphones;
  if (href.includes("/orders") || href.endsWith("/f")) return ClipboardList;
  if (href.includes("/sites")) return Store;
  if (href.includes("/products")) return Package;
  if (href.includes("/print")) return Printer;
  if (href.includes("/pickup")) return MapPin;
  // Закупка цветов проверяется РАНЬШЕ финансов: она лежит и внутри "/dashboard/finance/…",
  // и отдельным пунктом у флориста, а кошелёк там означал бы «раздел про деньги вообще».
  if (href.includes("/flower-expenses")) return ShoppingBasket;
  // Проверка финансов идёт РАНЬШЕ флористов: у "/dashboard/finance/florists"
  // иначе выиграла бы иконка флористов, и раздел выглядел бы их дубликатом.
  if (href.includes("/finance")) return Wallet;
  if (href.includes("/florists")) return Flower2;
  if (href.includes("/automations")) return Zap;
  if (href.includes("/reviews")) return Star;
  if (href.includes("/expenses")) return Receipt;
  // Пользователи, Telegram, печать и Burq стали вкладками внутри «Настроек» — в меню их
  // адресов больше нет, и своих иконок им не нужно.
  if (href.includes("/settings")) return Settings;
  // Кружок остаётся запасным вариантом для пунктов, которые появятся позже: пустое место на
  // их строке ломало бы выравнивание всего списка.
  return Circle;
}

/**
 * Самый длинный адрес пункта, которому подходит текущий путь, — или null.
 * Кроме собственного href учитываются чужие адреса из item.match: страница раздела может
 * лежать вне его сегмента (вкладка Burq в «Настройках» живёт по /dashboard/burq).
 */
function matchedPrefix(pathname: string, item: NavItem): string | null {
  let best: string | null = null;
  for (const prefix of [item.href, ...(item.match ?? [])]) {
    if (pathname !== prefix && !pathname.startsWith(prefix + "/")) continue;
    if (!best || prefix.length > best.length) best = prefix;
  }
  return best;
}

/**
 * Активен пункт с САМЫМ ДЛИННЫМ подходящим адресом, а не любой подходящий.
 *
 * Иначе «Мои заказы» (/dashboard/f) подсвечивались всегда: их адрес — префикс всех
 * остальных страниц кабинета (/dashboard/f/finance, /dashboard/f/pickup …), и по правилу
 * «начинается с» они выигрывали на каждой вкладке.
 */
function isActive(pathname: string, item: NavItem, nav: NavItem[]) {
  const mine = matchedPrefix(pathname, item);
  if (!mine) return false;

  const longest = nav.reduce((acc, other) => {
    const prefix = matchedPrefix(pathname, other);
    return prefix && prefix.length > acc ? prefix.length : acc;
  }, 0);
  return mine.length === longest;
}

export function SidebarNav({ nav, variant }: { nav: NavItem[]; variant: "sidebar" | "mobile" }) {
  const pathname = usePathname();

  if (variant === "mobile") {
    return (
      <nav className="flex gap-1 overflow-x-auto border-b border-slate-200 bg-white px-2 py-2 md:hidden">
        {nav.map((item) => {
          const Icon = iconFor(item.href);
          const active = isActive(pathname, item, nav);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex items-center gap-1.5 whitespace-nowrap rounded-lg px-3 py-1.5 text-sm font-medium transition-colors",
                active ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100"
              )}
            >
              <Icon className="size-4" />
              {item.label}
            </Link>
          );
        })}
      </nav>
    );
  }

  return (
    <nav className="flex flex-col gap-0.5 px-3">
      {nav.map((item) => {
        const Icon = iconFor(item.href);
        const active = isActive(pathname, item, nav);
        return (
          <Link
            key={item.href}
            href={item.href}
            className={cn(
              "flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
              active ? "bg-slate-100 text-slate-900" : "text-slate-600 hover:bg-slate-50 hover:text-slate-900"
            )}
          >
            <Icon className={cn("size-4 shrink-0", active ? "text-slate-700" : "text-slate-400")} />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
