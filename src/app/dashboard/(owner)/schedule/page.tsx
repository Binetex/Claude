import Link from "next/link";
import { prisma } from "@/lib/db";
import { cn } from "@/lib/cn";
import { todayStrInTz, DEFAULT_STORE_TZ } from "@/lib/tz";
import { loadDaySchedule, type DaySchedule, type ScheduleOrder } from "@/modules/capacity/load";
import type { MorningVerdict } from "@/modules/capacity/morning";
import { MorningLock } from "./ScheduleControls";

export const dynamic = "force-dynamic";

/** Сколько дней вперёд показываем (решение владельца: три). */
const DAYS_AHEAD = 3;
const WEEKDAY = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];

/** Плашка — ровно то, что ИИ сейчас обещает клиентам этого флориста про утро. */
const VERDICT: Record<MorningVerdict, { label: string; cls: string }> = {
  FIRST: { label: "к 12:00", cls: "bg-emerald-50 text-emerald-700" },
  AVAILABLE: { label: "к 13–15", cls: "bg-amber-50 text-amber-700" },
  FULL: { label: "закрыто", cls: "bg-rose-50 text-rose-700" },
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

  // Колонки — флористы, которые есть хотя бы в одном из дней (выходной тоже показываем).
  const florists = new Map<string, string>();
  for (const s of schedules) for (const f of s.florists) florists.set(f.id, f.name);
  const columns = [...florists.entries()];
  const shopsOf = (id: string) => firsts.filter((p) => p.floristId === id).map((p) => p.site.shortName).join(", ");
  const grid = { gridTemplateColumns: `100px repeat(${Math.max(1, columns.length)}, minmax(0, 1fr)) 36px` };

  return (
    <div className="space-y-2">
      <div className="text-right">
        <span className="text-xs text-slate-400">● маленький букет · ⬤ большой (от $250)</span>
      </div>

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
        <div className="grid items-center bg-slate-50 px-4 py-2 text-xs text-slate-500" style={grid}>
          <span />
          {columns.map(([id, name]) => (
            <span key={id} className="truncate">
              <span className="font-medium text-slate-700">{name}</span>
              {shopsOf(id) && <span className="text-slate-400"> · {shopsOf(id)}</span>}
            </span>
          ))}
          <span />
        </div>

        {schedules.map((s, i) => (
          <DayRow key={s.day} schedule={s} columns={columns} grid={grid} isToday={i === 0} />
        ))}
      </div>
    </div>
  );
}

function DayRow({ schedule: s, columns, grid, isToday }: { schedule: DaySchedule; columns: [string, string][]; grid: React.CSSProperties; isToday: boolean }) {
  const date = new Date(`${s.day}T00:00:00Z`);
  const byId = new Map(s.florists.map((f) => [f.id, f]));
  const hasOrders = s.florists.some((f) => f.morning.length > 0);

  return (
    <details open={isToday} className="border-t border-slate-100">
      <summary className="grid cursor-pointer list-none items-center px-4 py-2.5 hover:bg-slate-50/60" style={grid}>
        <span className="text-sm">
          <b className="font-medium text-slate-800">
            {WEEKDAY[date.getUTCDay()]} {date.getUTCDate()}
          </b>
          {isToday && <span className="ml-1.5 text-xs text-slate-400">сегодня</span>}
        </span>
        {columns.map(([id]) => {
          const f = byId.get(id);
          if (!f || f.dayOff) return <span key={id} className="text-xs text-slate-400">выходной</span>;
          const v = s.closure ? { label: "закрыто вручную", cls: VERDICT.FULL.cls } : VERDICT[f.verdict];
          return (
            <span key={id} className="flex min-w-0 items-center gap-2">
              <span className={cn("shrink-0 rounded-md px-2 py-0.5 text-sm", v.cls)}>{v.label}</span>
              <span className="truncate tracking-widest text-slate-400">{f.morning.map((o) => (o.big ? "⬤" : "●")).join(" ")}</span>
            </span>
          );
        })}
        <MorningLock day={s.day} closed={!!s.closure} />
      </summary>

      {hasOrders && (
        <div className="grid gap-x-4 border-t border-dashed border-slate-100 px-4 pb-3 pt-1" style={grid}>
          <span />
          {columns.map(([id]) => (
            <ul key={id} className="min-w-0 space-y-1 text-sm text-slate-600">
              {(byId.get(id)?.morning ?? []).map((o) => (
                <OrderLine key={o.id} o={o} />
              ))}
            </ul>
          ))}
          <span />
        </div>
      )}
    </details>
  );
}

function OrderLine({ o }: { o: ScheduleOrder }) {
  return (
    <li className="truncate">
      <Link href={`/dashboard/orders/${o.id}`} className="text-slate-800 hover:underline">
        {o.orderNumber}
      </Link>
      <span className="text-slate-400"> · </span>
      {o.bouquets}
      {o.big && <span className="ml-1 rounded bg-violet-100 px-1 text-[11px] text-violet-700">большой</span>}
      {o.wish && <span className="text-sky-700"> · клиент: {o.wish}</span>}
    </li>
  );
}
