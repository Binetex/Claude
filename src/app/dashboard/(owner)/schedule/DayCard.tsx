import Link from "next/link";
import { cn } from "@/lib/cn";
import type { DaySchedule, FloristDay, ScheduleOrder } from "@/modules/timing/load";
import { fmtDuration, EARLIEST_DELIVERY_MIN, type ClosureLevel } from "@/modules/timing/day";
import { DayLock } from "./ScheduleControls";

/**
 * Карточка дня — одна на обеих вкладках «Графика доставки». День → флористы в две колонки →
 * очередь флориста: кого собирает первым и когда букет будет у клиента по расписанию
 * (modules/timing), а у доставленных — когда привезли на самом деле.
 */

const WEEKDAY = ["воскресенье", "понедельник", "вторник", "среда", "четверг", "пятница", "суббота"];
const MONTH = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];

/** Шкала времени: весь день доставки, с 9:00 до 21:00. */
const AXIS_FROM = 9 * 60;
const AXIS_TO = 21 * 60;
const HOURS = [9, 11, 13, 15, 17, 19, 21];

function hm(min: number): string {
  return `${Math.floor(min / 60)}:${String(min % 60).padStart(2, "0")}`;
}
function pct(min: number): number {
  return Math.min(100, Math.max(0, ((min - AXIS_FROM) / (AXIS_TO - AXIS_FROM)) * 100));
}

export function dayTitle(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  return `${WEEKDAY[d.getUTCDay()]}, ${d.getUTCDate()} ${MONTH[d.getUTCMonth()]}`;
}

export function DayCard({
  schedule: s,
  label,
  shopsOf,
  mode,
}: {
  schedule: DaySchedule;
  label?: string;
  shopsOf: (id: string) => string;
  /** plan — впереди: очередь по расписанию, замок дня; review — прошло: как успели. */
  mode: "plan" | "review";
}) {
  const florists = mode === "review" ? s.florists.filter((f) => f.orders.length > 0) : s.florists;
  const all = s.florists.flatMap((f) => f.orders);
  const delivered = all.filter((o) => o.deliveredAt);
  const lateCount = delivered.filter((o) => o.late).length;
  const riskCount = all.filter((o) => o.atRisk).length;

  return (
    <section className="rounded-2xl border border-slate-200 bg-white shadow-sm">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-6 py-4">
        <div className="flex items-baseline gap-3">
          {label && <h2 className="text-xl font-semibold text-slate-900">{label}</h2>}
          <span className={cn(label ? "text-base text-slate-500" : "text-xl font-semibold text-slate-900")}>{dayTitle(s.day)}</span>
        </div>
        {mode === "plan" ? (
          <div className="flex items-center gap-3">
            {riskCount > 0 && <span className="whitespace-nowrap rounded-full bg-rose-50 px-3 py-1 text-sm font-medium text-rose-700">Не успеваем: {riskCount}</span>}
            <DayLock day={s.day} level={s.closure?.level ?? null} />
          </div>
        ) : (
          delivered.length > 0 && (
            <span className={cn("rounded-full px-3 py-1 text-sm font-medium", lateCount ? "bg-rose-50 text-rose-700" : "bg-emerald-50 text-emerald-700")}>
              {lateCount ? `Опоздали: ${lateCount} из ${delivered.length}` : `Все ${delivered.length} вовремя`}
            </span>
          )
        )}
      </header>

      {mode === "plan" && s.closure && (
        <div className="mx-6 mt-4 rounded-lg bg-rose-50 px-4 py-2.5 text-sm text-rose-700">{CLOSURE_NOTE[s.closure.level]}</div>
      )}
      {mode === "plan" && s.unassigned.length > 0 && (
        <div className="mx-6 mt-4 rounded-lg bg-amber-50 px-4 py-2.5 text-sm text-amber-800">
          Без флориста: {s.unassigned.map((o) => o.orderNumber).join(", ")} — в расписание не входят, пока не назначены
        </div>
      )}

      {florists.length === 0 ? (
        <p className="px-6 py-5 text-sm text-slate-400">Заказов не было</p>
      ) : (
        <div className="grid divide-y divide-slate-100 md:grid-cols-2 md:divide-x md:divide-y-0">
          {florists.map((f) => (
            <FloristPanel key={f.id} f={f} shops={shopsOf(f.id)} mode={mode} sameDayCheck={s.sameDayCheck} />
          ))}
        </div>
      )}
    </section>
  );
}

/** Что значит замок дня — для ИИ и для сайтов. */
const CLOSURE_NOTE: Record<ClosureLevel, string> = {
  MORNING: "Утро закрыто вручную — ИИ и сайты не предлагают доставку раньше 15:00",
  DAY: "Открыт только вечер — ИИ и сайты не предлагают доставку раньше 18:00",
  FULL: "День закрыт — новых заказов на него ИИ и сайты не берут; принятые возим как обычно",
};

/** Самое раннее для нового клиента — ровно то, что ИИ сейчас называет клиентам TheFlow. */
function EarliestChip({ min, check }: { min: number | null; check: boolean }) {
  // После 13:00 цветы на сегодня уже не закупить: сегодняшний заказ ИИ не обещает — решаете вы.
  if (check) return <span className="whitespace-nowrap rounded-full bg-amber-50 px-3 py-1 text-sm font-medium text-amber-700 ring-1 ring-amber-200">Новый заказ на сегодня — решаете вы</span>;
  if (min == null) return <span className="rounded-full bg-rose-50 px-3 py-1 text-sm font-medium text-rose-700 ring-1 ring-rose-200">Новый заказ уже не успеть</span>;
  const tone = min <= 13 * 60 ? "bg-emerald-50 text-emerald-700 ring-emerald-200" : min <= 16 * 60 ? "bg-amber-50 text-amber-700 ring-amber-200" : "bg-rose-50 text-rose-700 ring-rose-200";
  // Раньше 11 бывает только заранее, и ИИ называет это время, только если клиент сам просит раньше.
  const label = min < EARLIEST_DELIVERY_MIN ? `к ${hm(EARLIEST_DELIVERY_MIN)} · если клиент просит — с ${hm(min)}` : `к ${hm(min)}`;
  return <span className={cn("whitespace-nowrap rounded-full px-3 py-1 text-sm font-medium ring-1", tone)}>Новый заказ — {label}</span>;
}

function FloristPanel({ f, shops, mode, sameDayCheck }: { f: FloristDay; shops: string; mode: "plan" | "review"; sameDayCheck: boolean }) {
  if (f.dayOff && mode === "plan" && f.orders.length === 0) {
    return (
      <div className="px-6 py-5">
        <div className="text-lg font-medium text-slate-400">{f.name}</div>
        <div className="mt-1 text-sm text-slate-400">Выходной</div>
      </div>
    );
  }
  return (
    <div className="space-y-4 px-6 py-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-lg font-medium text-slate-900">{f.name}</div>
          <div className="text-sm text-slate-400">
            {mode === "plan" && `начинает в ${hm(f.workStartMin)}`}
            {mode === "plan" && shops && " · "}
            {shops}
          </div>
          {mode === "plan" && f.earlyStartMin != null && (
            <div className="mt-1 text-sm font-medium text-amber-700">Ранний заказ: начать в {hm(f.earlyStartMin)}</div>
          )}
        </div>
        {mode === "plan" && <EarliestChip min={f.newClientEarliest} check={sameDayCheck} />}
      </div>

      {f.orders.length > 0 ? (
        <div className="space-y-4">
          <Axis />
          {f.orders.map((o) => (
            <OrderRow key={o.id} o={o} />
          ))}
        </div>
      ) : (
        <p className="text-sm text-slate-400">Заказов нет</p>
      )}
    </div>
  );
}

function Axis() {
  return (
    <div className="relative h-4 text-[11px] text-slate-400">
      {HOURS.map((h) => (
        <span key={h} className="absolute -translate-x-1/2" style={{ left: `${pct(h * 60)}%` }}>
          {h}:00
        </span>
      ))}
    </div>
  );
}

function OrderRow({ o }: { o: ScheduleOrder }) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="flex items-baseline gap-2">
          {o.seq != null && <span className="inline-flex size-5 items-center justify-center rounded-full bg-slate-100 text-xs font-medium text-slate-600">{o.seq}</span>}
          <Link href={`/dashboard/orders/${o.id}`} className="font-medium text-slate-800 hover:underline">
            {o.orderNumber}
          </Link>
        </span>
        <span className="text-sm text-slate-500">
          {o.big && <span className="mr-2 rounded bg-violet-100 px-1.5 py-0.5 text-xs text-violet-700">большой</span>}
          {o.bouquets}
        </span>
      </div>

      {/* Шкала: отрезок — обещанное окно, кольцо — когда привезём по расписанию, точка — когда
          привезли. */}
      <div className="relative h-3 rounded-full bg-slate-100">
        {HOURS.slice(1, -1).map((h) => (
          <span key={h} className="absolute top-0 h-full w-px bg-white" style={{ left: `${pct(h * 60)}%` }} />
        ))}
        {o.promised && (
          <span
            className="absolute top-0 h-full rounded-full bg-sky-100"
            style={{ left: `${pct(o.promised.from)}%`, width: `${Math.max(1.5, pct(o.promised.to) - pct(o.promised.from))}%` }}
          />
        )}
        {o.plannedAt != null && o.deliveredMin == null && (
          <span
            className={cn("absolute top-1/2 size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-[3px] bg-white", o.atRisk ? "border-rose-500" : "border-slate-500")}
            style={{ left: `${pct(o.plannedAt)}%` }}
          />
        )}
        {o.deliveredMin != null && (
          <span
            className={cn("absolute top-1/2 size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white", o.late ? "bg-rose-500" : "bg-emerald-500")}
            style={{ left: `${pct(o.deliveredMin)}%` }}
          />
        )}
      </div>

      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-sm">
        <span className="text-slate-500">окно {o.promised ? `${hm(o.promised.from)}–${hm(o.promised.to)}` : o.window}</span>
        {o.wish && <span className="text-slate-500">клиент писал: {o.wish}</span>}
        {o.deliveredAt ? (
          <span className={o.late ? "font-medium text-rose-600" : "text-emerald-600"}>
            привезли {o.deliveredAt}
            {o.late ? ` · опоздали на ${fmtDuration(o.lateMin)}` : o.lateMin > 0 ? ` · на ${fmtDuration(o.lateMin)} позже, нормально` : ""}
          </span>
        ) : o.plannedAt != null ? (
          <span className={o.atRisk ? "font-medium text-rose-600" : "text-slate-600"}>
            по плану к {hm(o.plannedAt)}
            {o.atRisk && o.promised && ` · не успеваем на ${fmtDuration(o.plannedAt - o.promised.to)}`}
          </span>
        ) : (
          <span className="text-slate-400">{o.status === "DELIVERED" ? "доставлен" : o.status === "IN_TRANSIT" ? "в пути" : "собран, ждёт курьера"}</span>
        )}
      </div>
    </div>
  );
}
