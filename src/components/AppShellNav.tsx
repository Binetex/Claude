"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  ClipboardList,
  Store,
  Package,
  Flower2,
  Users,
  Headphones,
  Wallet,
  ShoppingBasket,
  MapPin,
  Printer,
  Truck,
  Zap,
  Star,
  Receipt,
  Send,
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
  if (href.includes("/users")) return Users;
  if (href.includes("/burq")) return Truck;
  if (href.includes("/automations")) return Zap;
  if (href.includes("/reviews")) return Star;
  if (href.includes("/expenses")) return Receipt;
  if (href.includes("/telegram")) return Send;
  // Кружок остаётся запасным вариантом для пунктов, которые появятся позже: пустое место на
  // их строке ломало бы выравнивание всего списка.
  return Circle;
}

/**
 * Активен пункт с САМЫМ ДЛИННЫМ подходящим href, а не любой подходящий.
 *
 * Иначе «Мои заказы» (/dashboard/f) подсвечивались всегда: их адрес — префикс всех
 * остальных страниц кабинета (/dashboard/f/finance, /dashboard/f/pickup …), и по правилу
 * «начинается с» они выигрывали на каждой вкладке.
 */
function isActive(pathname: string, href: string, nav: NavItem[]) {
  if (pathname === href) return true;
  if (!pathname.startsWith(href + "/")) return false;

  const longest = nav
    .filter((t) => pathname === t.href || pathname.startsWith(t.href + "/"))
    .reduce((a, b) => (a.href.length >= b.href.length ? a : b));
  return longest.href === href;
}

export function SidebarNav({ nav, variant }: { nav: NavItem[]; variant: "sidebar" | "mobile" }) {
  const pathname = usePathname();

  if (variant === "mobile") {
    return (
      <nav className="flex gap-1 overflow-x-auto border-b border-slate-200 bg-white px-2 py-2 md:hidden">
        {nav.map((item) => {
          const Icon = iconFor(item.href);
          const active = isActive(pathname, item.href, nav);
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
        const active = isActive(pathname, item.href, nav);
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
