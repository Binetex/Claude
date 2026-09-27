"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/dashboard/schedule", label: "Утро по дням" },
  { href: "/dashboard/schedule/history", label: "Как успели" },
] as const;

export function ScheduleTabs() {
  const pathname = usePathname() ?? "";
  return (
    <nav className="flex flex-wrap gap-1 border-b border-slate-200">
      {TABS.map((t) => (
        <Link
          key={t.href}
          href={t.href}
          className={
            pathname === t.href
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
