"use client";
import Link from "next/link";

/** Вкладки очереди. Число рядом с «сегодня» — единственное, что требует действия прямо сейчас. */
export function QueueTabs({
  active,
  counts,
}: {
  active: string;
  counts: { today: number; waiting: number; toCheck: number };
}) {
  const tabs = [
    { key: "today", label: "Сегодня", count: counts.today, hot: counts.today > 0 },
    { key: "waiting", label: "Ждут ответа", count: counts.waiting, hot: false },
    { key: "check", label: "На проверке", count: counts.toCheck, hot: false },
    { key: "closed", label: "Закрытые", count: null, hot: false },
  ];

  return (
    <div className="flex flex-wrap gap-1.5">
      {tabs.map((t) => {
        const on = active === t.key;
        return (
          <Link
            key={t.key}
            href={`/dashboard/cc/reviews?tab=${t.key}`}
            className={`inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm transition-colors ${
              on ? "border-slate-900 bg-slate-900 text-white" : "border-slate-200 bg-white text-slate-700 hover:border-slate-300"
            }`}
          >
            {t.label}
            {t.count !== null && t.count > 0 && (
              <span
                className={`rounded-full px-1.5 text-[11px] ${
                  on ? "bg-white/20" : t.hot ? "bg-red-600 text-white" : "bg-slate-100 text-slate-600"
                }`}
              >
                {t.count}
              </span>
            )}
          </Link>
        );
      })}
    </div>
  );
}
