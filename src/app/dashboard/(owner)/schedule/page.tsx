import { prisma } from "@/lib/db";
import { todayStrInTz, DEFAULT_STORE_TZ, localClock } from "@/lib/tz";
import { earliestToday, leadMinutes } from "@/modules/capacity/morning";
import { loadDaySchedule } from "@/modules/capacity/load";
import { DayCard } from "./DayCard";
import { loadShopsOf } from "./shops";

export const dynamic = "force-dynamic";

/** Сколько дней вперёд показываем (решение владельца: три). */
const DAYS_AHEAD = 3;
const LABELS = ["Сегодня", "Завтра", "Послезавтра"];

export default async function SchedulePage() {
  const today = todayStrInTz(DEFAULT_STORE_TZ);
  const days = Array.from({ length: DAYS_AHEAD }, (_, i) => new Date(Date.parse(`${today}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10));
  const [schedules, shopsOf] = await Promise.all([Promise.all(days.map((d) => loadDaySchedule(prisma, d))), loadShopsOf(prisma)]);

  // Два примера: маленький букет в паре миль от флориста и большой миль за пятнадцать. Раньше
  // полудня строка не нужна: до 12:00 мы не возим в любом случае.
  const [h, m] = localClock(DEFAULT_STORE_TZ).timeStr.split(":").map(Number);
  const hm = (x: number) => `${Math.floor(x / 60)}:${String(x % 60).padStart(2, "0")}`;
  const near = earliestToday(h * 60 + m, leadMinutes({ big: false, miles: 2 }));
  const far = earliestToday(h * 60 + m, leadMinutes({ big: true, miles: 15 }));
  const earliest = far > 12 * 60 ? { near: hm(Math.max(near, 12 * 60)), far: hm(far) } : null;

  return (
    <div className="space-y-5">
      {schedules.map((s, i) => (
        <DayCard key={s.day} schedule={s} label={LABELS[i]} shopsOf={shopsOf} mode="plan" earliest={i === 0 ? earliest : null} />
      ))}
    </div>
  );
}
