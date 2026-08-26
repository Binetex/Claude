"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

export type ReviewTab = { href: string; label: string; badge?: number; alarming?: boolean };

/** Вкладки раздела. Число появляется только когда есть о чём сказать. */
export function ReviewTabs({ tabs }: { tabs: ReviewTab[] }) {
  const pathname = usePathname();
  return (
    <div className="flex flex-wrap gap-1.5">
      {tabs.map((t) => {
        const on = pathname === t.href;
        return (
          <Link
            key={t.href}
            href={t.href}
            className={`inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm transition-colors ${
              on ? "border-slate-900 bg-slate-900 text-white" : "border-slate-200 bg-white text-slate-700 hover:border-slate-300"
            }`}
          >
            {t.label}
            {!!t.badge && t.badge > 0 && (
              <span
                className={`rounded-full px-1.5 text-[11px] ${
                  on ? "bg-white/20" : t.alarming ? "bg-amber-500 text-white" : "bg-slate-100 text-slate-600"
                }`}
              >
                {t.badge}
              </span>
            )}
          </Link>
        );
      })}
    </div>
  );
}
