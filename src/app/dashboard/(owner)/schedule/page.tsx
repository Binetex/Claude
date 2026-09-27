import Link from "next/link";
import { prisma } from "@/lib/db";
import { cn } from "@/lib/cn";
import { todayStrInTz, DEFAULT_STORE_TZ } from "@/lib/tz";
import { loadDaySchedule, type DaySchedule, type FloristDay, type ScheduleOrder } from "@/modules/capacity/load";
import type { MorningVerdict } from "@/modules/capacity/morning";
import { MorningLock } from "./ScheduleControls";

export const dynamic = "force-dynamic";

/** Сколько дней вперёд показываем (решение владельца: три). */
const DAYS_AHEAD = 3;
const WEEKDAY = ["воскресенье", "понедельник", "вторник", "среда", "четверг", "пятница", "суббота"];
const MONTH = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];

/** Статус — ровно то, что ИИ сейчас обещает клиентам этого флориста про утро. */
const VERDICT: Record<MorningVerdict, { label: string; cls: string; cell: string }> = {
  FIRST: { label: "Утро свободно · к 12:00", cls: "bg-emerald-50 text-emerald-700", cell: "bg-emerald-400" },
  AVAILABLE: { label: "Утро есть · к 13–15", cls: "bg-amber-50 text-amber-700", cell: "bg-amber-400" },
  FULL: { label: "Утро закрыто", cls: "bg-rose-50 text-rose-700", cell: "bg-rose-400" },
};

function shift(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

export default async function SchedulePage() {
  const today = todayStrInTz(DEFAULT_STORE_TZ);
  const days = Array.from({ length: DAYS_AHEAD }, (_, i) => shift(today, i));
  const [schedules, firsts] = await Promise.all([
    Promise.all(days.map((d) => loadDaySchedule(prisma, d))),
    // Какие магазины на ком: ИИ новому клиенту магазина отвечает по его первому флористу.
    prisma.siteFloristPriority.findMany({ where: { position: 0 }, select: { floristId: true, site: { select: { shortName: true } } } }),
  ]);
  const shopsOf = (id: string) => firsts.filter((p) => p.floristId === id).map((p) => p.site.shortName).join(", ");

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      {schedules.map((s, i) => (
        <DayCard key={s.day} schedule={s} label={["Сегодня", "Завтра", "Послезавтра"][i]} shopsOf={shopsOf} />
      ))}
    </div>
  );
}

function DayCard({ schedule: s, label, shopsOf }: { schedule: DaySchedule; label: string; shopsOf: (id: string) => string }) {
  const date = new Date(`${s.day}T00:00:00Z`);
  return (
    <section className="flex flex-col rounded-xl border border-slate-200 bg-white">
      <header className="flex items-start justify-between gap-2 border-b border-slate-100 px-5 py-4">
        <div>
          <div className="text-base font-semibold text-slate-900">{label}</div>
          <div className="text-sm text-slate-500">
            {WEEKDAY[date.getUTCDay()]}, {date.getUTCDate()} {MONTH[date.getUTCMonth()]}
          </div>
        </div>
        <MorningLock day={s.day} closed={!!s.closure} />
      </header>

      {s.closure && (
        <div className="mx-5 mt-4 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">
          Утро закрыто вручную — ИИ и сайт его не предлагают
        </div>
      )}

      <div className="divide-y divide-slate-100">
        {s.florists.map((f) => (
          <FloristBlock key={f.id} f={f} shops={shopsOf(f.id)} closed={!!s.closure} />
        ))}
      </div>
    </section>
  );
}

function FloristBlock({ f, shops, closed }: { f: FloristDay; shops: string; closed: boolean }) {
  if (f.dayOff) {
    return (
      <div className="flex items-baseline justify-between px-5 py-4">
        <span className="font-medium text-slate-400">{f.name}</span>
        <span className="text-sm text-slate-400">выходной</span>
      </div>
    );
  }
  const v = VERDICT[closed ? "FULL" : f.verdict];
  return (
    <div className="space-y-3 px-5 py-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-medium text-slate-800">{f.name}</div>
          {shops && <div className="truncate text-xs text-slate-400">{shops}</div>}
        </div>
        <span className={cn("shrink-0 rounded-full px-2.5 py-1 text-xs font-medium", v.cls)}>{v.label}</span>
      </div>

      <Cells used={f.morningPoints} capacity={f.capacity} fill={v.cell} />

      {f.morning.length > 0 ? (
        <ul className="space-y-1.5">
          {f.morning.map((o) => (
            <OrderLine key={o.id} o={o} />
          ))}
        </ul>
      ) : (
        <p className="text-sm text-slate-400">Утренних заказов нет</p>
      )}
    </div>
  );
}

/**
 * Клетки утра: одна клетка — маленький букет, большой занимает две. Сверх лимита клетки
 * дорисовываются красными — видно, насколько утро перебрано.
 */
function Cells({ used, capacity, fill }: { used: number; capacity: number; fill: string }) {
  const total = Math.max(capacity, used);
  return (
    <div className="flex items-center gap-2">
      <div className="flex gap-1">
        {Array.from({ length: total }, (_, i) => (
          <span
            key={i}
            className={cn("h-2.5 w-6 rounded-sm", i < used ? (i >= capacity ? "bg-rose-500" : fill) : "bg-slate-100")}
          />
        ))}
      </div>
      <span className="text-xs text-slate-400">
        {used} из {capacity}
      </span>
    </div>
  );
}

function OrderLine({ o }: { o: ScheduleOrder }) {
  return (
    <li className="flex items-baseline justify-between gap-3 text-sm">
      <span className="min-w-0">
        <Link href={`/dashboard/orders/${o.id}`} className="text-slate-700 hover:underline">
          {o.orderNumber}
        </Link>
        {o.wish && <span className="block truncate text-xs text-sky-700">клиент: {o.wish}</span>}
      </span>
      <span className="shrink-0 text-slate-500">
        {o.big && <span className="mr-1.5 rounded bg-violet-100 px-1.5 py-0.5 text-[11px] text-violet-700">большой</span>}
        {o.bouquets}
      </span>
    </li>
  );
}
