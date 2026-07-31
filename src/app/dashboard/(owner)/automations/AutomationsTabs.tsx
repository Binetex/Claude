"use client";
/**
 * Разделы Automations. Одиночные уведомления по событию заказа и маркетинговые цепочки —
 * разные инструменты с разной логикой, поэтому живут на отдельных вкладках, а не в общем списке.
 */
import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/dashboard/automations", label: "Order Notifications" },
  { href: "/dashboard/automations/flows", label: "Marketing Flows" },
  { href: "/dashboard/automations/templates", label: "Templates" },
  { href: "/dashboard/automations/history", label: "History" },
] as const;

export function AutomationsTabs() {
  const pathname = usePathname() ?? "";
  // Активна самая ДЛИННАЯ подходящая вкладка: страницы вида /automations/new и /automations/<id>
  // относятся к первой вкладке, а /automations/flows/<id> — ко второй.
  const active = [...TABS]
    .map((t) => t.href)
    .filter((href) => pathname === href || pathname.startsWith(`${href}/`))
    .sort((a, b) => b.length - a.length)[0];

  return (
    <nav className="flex flex-wrap gap-1 border-b border-slate-200">
      {TABS.map((t) => {
        const isActive = t.href === active;
        return (
          <Link
            key={t.href}
            href={t.href}
            className={
              isActive
                ? "-mb-px border-b-2 border-slate-800 px-3 py-2 text-sm font-medium text-slate-800"
                : "-mb-px border-b-2 border-transparent px-3 py-2 text-sm text-slate-500 hover:text-slate-700"
            }
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
