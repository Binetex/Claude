"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/dashboard/consumables", label: "Журнал" },
  { href: "/dashboard/consumables/receipts", label: "Приход и остаток" },
  { href: "/dashboard/consumables/items", label: "Справочник" },
] as const;

export function ConsumablesTabs() {
  const pathname = usePathname() ?? "";
  // Активна самая ДЛИННАЯ подходящая вкладка: страница дня (/consumables/2026-09-06) относится
  // к «Журналу», а не к вкладкам, чьи адреса тоже начинаются с корня раздела.
  const active = [...TABS]
    .map((t) => t.href)
    .filter((href) => pathname === href || pathname.startsWith(`${href}/`))
    .sort((a, b) => b.length - a.length)[0] ?? "/dashboard/consumables";

  return (
    <nav className="flex flex-wrap gap-1 border-b border-slate-200">
      {TABS.map((t) => (
        <Link
          key={t.href}
          href={t.href}
          className={
            t.href === active
              ? "-mb-px border-b-2 border-slate-800 px-3 py-2 text-sm font-medium text-slate-800"
              : "-mb-px border-b-2 border-transparent px-3 py-2 text-sm text-slate-500 hover:text-slate-700"
          }
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
