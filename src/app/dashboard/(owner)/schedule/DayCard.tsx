import Link from "next/link";
import { cn } from "@/lib/cn";
import type { DaySchedule, FloristDay, ScheduleOrder } from "@/modules/capacity/load";
import { fmtDuration, type MorningVerdict } from "@/modules/capacity/morning";
import { MorningLock } from "./ScheduleControls";

/**
 * Карточка дня — одна на обеих вкладках «Графика доставки». Крупно и по полочкам: день →
 * флористы в две колонки → каждый заказ строкой со шкалой времени «хотел / привезли».
 */

const WEEKDAY = ["воскресенье", "понедельник", "вторник", "среда", "четверг", "пятница", "суббота"];
const MONTH = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];

/** Статус — ровно то, что ИИ сейчас обещает клиентам этого флориста про утро. */
const VERDICT: Record<MorningVerdict, { label: string; cls: string; cell: string }> = {
  FIRST: { label: "Утро свободно · к 12:00", cls: "bg-emerald-50 text-emerald-700 ring-emerald-200", cell: "bg-emerald-400" },
  AVAILABLE: { label: "Утро есть · к 13–15", cls: "bg-amber-50 text-amber-700 ring-amber-200", cell: "bg-amber-400" },
  FULL: { label: "Утро закрыто", cls: "bg-rose-50 text-rose-700 ring-rose-200", cell: "bg-rose-400" },
};

/** Шкала времени: с 11:00 до 17:00 — утро и запас на опоздания. */
const AXIS_FROM = 11 * 60;
const AXIS_TO = 17 * 60;
const HOURS = [11, 12, 13, 14, 15, 16, 17];

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
  earliest,
}: {
  schedule: DaySchedule;
  label?: string;
  /** Только у «Сегодня»: самое раннее время для маленького букета рядом и для большого/далеко. */
  earliest?: { near: string; far: string } | null;
  shopsOf: (id: string) => string;
  /** plan — впереди: статус ИИ, клетки, замок; review — прошло: только как успели. */
  mode: "plan" | "review";
}) {
  const florists = mode === "review" ? s.florists.filter((f) => f.morning.length > 0) : s.florists;
  const lateCount = s.florists.reduce((n, f) => n + f.morning.filter((o) => o.late).length, 0);
  const total = s.florists.reduce((n, f) => n + f.morning.length, 0);

  return (
    <section className="rounded-2xl border border-slate-200 bg-white shadow-sm">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-6 py-4">
        <div className="flex items-baseline gap-3">
          {label && <h2 className="text-xl font-semibold text-slate-900">{label}</h2>}
          <span className={cn(label ? "text-base text-slate-500" : "text-xl font-semibold text-slate-900")}>{dayTitle(s.day)}</span>
        </div>
        {mode === "plan" ? (
          <MorningLock day={s.day} closed={!!s.closure} />
        ) : (
          total > 0 && (
            <span className={cn("rounded-full px-3 py-1 text-sm font-medium", lateCount ? "bg-rose-50 text-rose-700" : "bg-emerald-50 text-emerald-700")}>
              {lateCount ? `Опоздали: ${lateCount} из ${total}` : `Все ${total} вовремя`}
            </span>
          )
        )}
      </header>

      {earliest && (
        <div className="mx-6 mt-4 rounded-lg bg-slate-50 px-4 py-2.5 text-sm text-slate-600">
          Если заказать сейчас: маленький букет рядом с флористом — не раньше <b className="font-medium text-slate-800">{earliest.near}</b>,
          большой или далеко — не раньше <b className="font-medium text-slate-800">{earliest.far}</b>. ИИ считает по букету и адресу
          каждого заказа.
        </div>
      )}

      {mode === "plan" && s.closure && (
        <div className="mx-6 mt-4 rounded-lg bg-rose-50 px-4 py-2.5 text-sm text-rose-700">Утро закрыто вручную — ИИ и сайт его не предлагают</div>
      )}

      {florists.length === 0 ? (
        <p className="px-6 py-5 text-sm text-slate-400">Утренних заказов не было</p>
      ) : (
        <div className="grid divide-y divide-slate-100 md:grid-cols-2 md:divide-x md:divide-y-0">
          {florists.map((f) => (
            <FloristPanel key={f.id} f={f} shops={shopsOf(f.id)} closed={!!s.closure} mode={mode} />
          ))}
        </div>
      )}
    </section>
  );
}

function FloristPanel({ f, shops, closed, mode }: { f: FloristDay; shops: string; closed: boolean; mode: "plan" | "review" }) {
  if (f.dayOff && mode === "plan") {
    return (
      <div className="px-6 py-5">
        <div className="text-lg font-medium text-slate-400">{f.name}</div>
        <div className="mt-1 text-sm text-slate-400">Выходной</div>
      </div>
    );
  }
  const v = VERDICT[closed ? "FULL" : f.verdict];
  return (
    <div className="space-y-4 px-6 py-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-lg font-medium text-slate-900">{f.name}</div>
          {shops && <div className="text-sm text-slate-400">{shops}</div>}
        </div>
        {mode === "plan" && <span className={cn("rounded-full px-3 py-1 text-sm font-medium ring-1", v.cls)}>{v.label}</span>}
      </div>

      {mode === "plan" && <Cells used={f.morningPoints} capacity={f.capacity} fill={v.cell} />}

      {f.morning.length > 0 ? (
        <div className="space-y-4">
          <Axis />
          {f.morning.map((o) => (
            <OrderRow key={o.id} o={o} />
          ))}
        </div>
      ) : (
        <p className="text-sm text-slate-400">Утренних заказов нет</p>
      )}
    </div>
  );
}

/** Клетки утра: клетка — маленький букет, большой занимает две. Сверх лимита — красные. */
function Cells({ used, capacity, fill }: { used: number; capacity: number; fill: string }) {
  const total = Math.max(capacity, used);
  return (
    <div className="flex items-center gap-3">
      <div className="flex gap-1.5">
        {Array.from({ length: total }, (_, i) => (
          <span key={i} className={cn("h-3.5 w-9 rounded", i < used ? (i >= capacity ? "bg-rose-500" : fill) : "bg-slate-100")} />
        ))}
      </div>
      <span className="text-sm text-slate-500">
        занято {used} из {capacity}
      </span>
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
  const lateTone = o.late ? "text-rose-600" : "text-emerald-600";
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <Link href={`/dashboard/orders/${o.id}`} className="font-medium text-slate-800 hover:underline">
          {o.orderNumber}
        </Link>
        <span className="text-sm text-slate-500">
          {o.big && <span className="mr-2 rounded bg-violet-100 px-1.5 py-0.5 text-xs text-violet-700">большой</span>}
          {o.bouquets}
        </span>
      </div>

      {/* Шкала: светлый отрезок — обещанное окно, тёмный — что просил клиент, точка — когда привезли. */}
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
        {o.want && (
          <span
            className="absolute top-0 h-full rounded-full bg-sky-300"
            style={{ left: `${pct(o.want.from)}%`, width: `${Math.max(1.5, pct(o.want.to) - pct(o.want.from))}%` }}
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
        {o.want && (
          <span className={o.wishMissed ? "text-amber-700" : "text-slate-500"}>
            просил {hm(o.want.from)}–{hm(o.want.to)}
            {o.wishMissed && " — не успели"}
          </span>
        )}
        {o.deliveredAt ? (
          <span className={o.late ? "font-medium text-rose-600" : "text-emerald-600"}>
            привезли {o.deliveredAt}
            {o.late ? ` · опоздали на ${fmtDuration(o.lateMin)}` : o.lateMin > 0 ? ` · на ${fmtDuration(o.lateMin)} позже, нормально` : ""}
          </span>
        ) : (
          <span className="text-slate-400">ещё не доставлен</span>
        )}
      </div>
    </div>
  );
}
