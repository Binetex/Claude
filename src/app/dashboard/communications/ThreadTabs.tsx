"use client";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";

export type ThreadTab = { key: string; label: string; count: number };

/**
 * Вкладки-категории «Других сообщений». Сохраняют остальные параметры адреса (магазин, период,
 * номер): переключение категории не должно сбрасывать выбранный фильтр.
 */
export function ThreadTabs({ tabs, active }: { tabs: ThreadTab[]; active: string }) {
  const pathname = usePathname() ?? "/dashboard/communications";
  const sp = useSearchParams();

  const hrefFor = (key: string) => {
    const next = new URLSearchParams(sp?.toString() ?? "");
    if (key === "ALL") next.delete("topic");
    else next.set("topic", key);
    const qs = next.toString();
    return qs ? `${pathname}?${qs}` : pathname;
  };

  return (
    <nav className="flex flex-wrap gap-1 border-b border-slate-200">
      {tabs.map((t) => {
        const isActive = t.key === active;
        return (
          <Link
            key={t.key}
            href={hrefFor(t.key)}
            className={
              isActive
                ? "-mb-px border-b-2 border-slate-800 px-3 py-2 text-sm font-medium text-slate-800"
                : "-mb-px border-b-2 border-transparent px-3 py-2 text-sm text-slate-500 hover:text-slate-700"
            }
          >
            {t.label}
            {t.count > 0 && (
              <span className={`ml-1.5 rounded-full px-1.5 py-0.5 text-[11px] ${isActive ? "bg-slate-800 text-white" : "bg-slate-100 text-slate-500"}`}>
                {t.count}
              </span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}
