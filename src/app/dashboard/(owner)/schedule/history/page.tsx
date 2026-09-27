import { prisma } from "@/lib/db";
import { todayStrInTz, DEFAULT_STORE_TZ } from "@/lib/tz";
import { loadDaySchedule } from "@/modules/timing/load";
import { DayCard, dayTitle } from "../DayCard";
import { loadShopsOf } from "../shops";

export const dynamic = "force-dynamic";

/** Сколько прошедших дней показываем: неделю — по ней видно, где расписание расходится с жизнью. */
const DAYS_BACK = 7;

export default async function ScheduleHistoryPage() {
  const today = todayStrInTz(DEFAULT_STORE_TZ);
  const days = Array.from({ length: DAYS_BACK }, (_, i) => new Date(Date.parse(`${today}T00:00:00Z`) - (i + 1) * 86_400_000).toISOString().slice(0, 10));
  const [schedules, shopsOf] = await Promise.all([Promise.all(days.map((d) => loadDaySchedule(prisma, d))), loadShopsOf(prisma)]);

  const hasOrders = (s: (typeof schedules)[number]) => s.florists.some((f) => f.orders.length > 0);
  const empty = schedules.filter((s) => !hasOrders(s));

  return (
    <div className="space-y-5">
      {schedules.filter(hasOrders).map((s) => (
        <DayCard key={s.day} schedule={s} shopsOf={shopsOf} mode="review" />
      ))}
      {/* Пустые дни — одной строкой: отдельная карточка на «ничего не было» только занимает экран. */}
      {empty.length > 0 && <p className="px-1 text-sm text-slate-400">Без заказов: {empty.map((s) => dayTitle(s.day)).join(" · ")}</p>}
    </div>
  );
}
