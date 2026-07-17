"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutDashboard, ClipboardList, Store, Package, Flower2, Users, Headphones, Circle } from "lucide-react";
import { cn } from "@/lib/cn";
import type { NavItem } from "./AppShell";

function iconFor(href: string) {
  if (href === "/dashboard") return LayoutDashboard;
  if (href.endsWith("/cc")) return Headphones;
  if (href.includes("/orders") || href.endsWith("/f")) return ClipboardList;
  if (href.includes("/sites")) return Store;
  if (href.includes("/products")) return Package;
  if (href.includes("/florists")) return Flower2;
  if (href.includes("/users")) return Users;
  return Circle;
}

function isActive(pathname: string, href: string) {
  if (href === "/dashboard") return pathname === "/dashboard";
  return pathname === href || pathname.startsWith(href + "/");
}

export function SidebarNav({ nav, variant }: { nav: NavItem[]; variant: "sidebar" | "mobile" }) {
  const pathname = usePathname();

  if (variant === "mobile") {
    return (
      <nav className="flex gap-1 overflow-x-auto border-b border-slate-200 bg-white px-2 py-2 md:hidden">
        {nav.map((item) => {
          const Icon = iconFor(item.href);
          const active = isActive(pathname, item.href);
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
        const active = isActive(pathname, item.href);
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
