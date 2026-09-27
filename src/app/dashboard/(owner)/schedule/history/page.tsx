import Link from "next/link";
import { prisma } from "@/lib/db";
import { cn } from "@/lib/cn";
import { todayStrInTz, DEFAULT_STORE_TZ } from "@/lib/tz";
import { loadDaySchedule } from "@/modules/capacity/load";

export const dynamic = "force-dynamic";

/** Сколько прошедших дней показываем: неделю — по ней видно, где лимит флориста занижен или завышен. */
const DAYS_BACK = 7;
const WEEKDAY = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];

export default async function ScheduleHistoryPage() {
  const today = todayStrInTz(DEFAULT_STORE_TZ);
  const days = Array.from({ length: DAYS_BACK }, (_, i) => new Date(Date.parse(`${today}T00:00:00Z`) - (i + 1) * 86_400_000).toISOString().slice(0, 10));
  const schedules = await Promise.all(days.map((d) => loadDaySchedule(prisma, d)));

  return (
    <div className="space-y-2">
      <div className="text-right">
        <span className="text-xs text-slate-400">время доставки из Burq · красное — позже окна или обещанного клиенту</span>
      </div>
      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
        {schedules.map((s) => {
          const date = new Date(`${s.day}T00:00:00Z`);
          const florists = s.florists.filter((f) => f.morning.length > 0);
          return (
            <div key={s.day} className="grid grid-cols-[100px_minmax(0,1fr)] gap-x-4 border-t border-slate-100 px-4 py-2.5 first:border-t-0">
              <b className="text-sm font-medium text-slate-800">
                {WEEKDAY[date.getUTCDay()]} {date.getUTCDate()}
              </b>
              {florists.length === 0 ? (
                <span className="text-sm text-slate-400">утренних заказов не было</span>
              ) : (
                <div className="space-y-1.5">
                  {florists.map((f) => {
                    const late = f.morning.filter((o) => o.late).length;
                    return (
                      <div key={f.id} className="text-sm">
                        <span className="font-medium text-slate-700">{f.name}</span>
                        <span className="text-slate-400"> · {f.morning.map((o) => (o.big ? "⬤" : "●")).join(" ")}</span>
                        {late > 0 && <span className="ml-2 text-rose-600">опоздали: {late}</span>}
                        <div className="mt-0.5 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-slate-500">
                          {f.morning.map((o) => (
                            <span key={o.id}>
                              <Link href={`/dashboard/orders/${o.id}`} className="hover:underline">{o.orderNumber}</Link>{" "}
                              <span className={cn(o.late ? "font-medium text-rose-600" : o.deliveredAt ? "text-emerald-600" : "text-slate-400")}>
                                {o.deliveredAt ?? "—"}
                              </span>
                            </span>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
