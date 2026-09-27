import Link from "next/link";
import { ChevronLeft, ChevronRight, Lock, Sun, Moon, UserX } from "lucide-react";
import { prisma } from "@/lib/db";
import { Card } from "@/components/ui/Card";
import { PageHeader } from "@/components/ui/misc";
import { cn } from "@/lib/cn";
import { todayStrInTz, DEFAULT_STORE_TZ, fmtDeliveryDateLong } from "@/lib/tz";
import { loadDaySchedule, loadWeekStrip, loadSiteVerdicts, type FloristDay, type ScheduleOrder } from "@/modules/capacity/load";
import { VERDICT_LABEL, BIG_BOUQUET_PRICE, type MorningVerdict } from "@/modules/capacity/morning";
import { MorningClosureToggle, CapacityStepper } from "./ScheduleControls";

export const dynamic = "force-dynamic";

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const WEEKDAY = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];

function shift(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

export default async function SchedulePage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const today = todayStrInTz(DEFAULT_STORE_TZ);
  const day = sp.day && DAY_RE.test(sp.day) ? sp.day : today;

  // Полоса: три дня назад (посмотреть, как успели) и неделя вперёд (куда ещё можно обещать).
  const stripDays = Array.from({ length: 10 }, (_, i) => shift(today, i - 3));
  const isPast = day < today;
  const [schedule, strip, sites] = await Promise.all([
    loadDaySchedule(prisma, day),
    loadWeekStrip(prisma, stripDays),
    isPast ? Promise.resolve([]) : loadSiteVerdicts(prisma, day),
  ]);

  return (
    <div className="space-y-5">
      <PageHeader
        title="График доставки"
        description="Утро — всё, что должно приехать до 15:00. Букет до $250 — 1 балл, от $250 — 2. Ассистент обещает утро по этим же цифрам."
      />

      {/* Полоса дней */}
      <div className="flex items-center gap-1 overflow-x-auto pb-1">
        <Link href={`?day=${shift(day, -1)}`} className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100" aria-label="Предыдущий день">
          <ChevronLeft className="size-4" />
        </Link>
        {strip.map((s) => {
          const wd = WEEKDAY[new Date(`${s.day}T00:00:00Z`).getUTCDay()];
          const tone = s.closed || s.fullest >= 1 ? "rose" : s.fullest >= 0.75 ? "amber" : "emerald";
          return (
            <Link
              key={s.day}
              href={`?day=${s.day}`}
              className={cn(
                "flex min-w-16 flex-col items-center rounded-lg border px-2 py-1.5 text-xs transition-colors",
                s.day === day ? "border-slate-800 bg-slate-800 text-white" : "border-slate-200 bg-white text-slate-600 hover:border-slate-300"
              )}
            >
              <span className="font-medium">
                {wd} {s.day.slice(8)}.{s.day.slice(5, 7)}
                {s.day === today && " ·"}
              </span>
              <span className="mt-0.5 flex items-center gap-1">
                {s.closed ? (
                  <Lock className="size-3 text-rose-500" />
                ) : (
                  <span
                    className={cn(
                      "size-2 rounded-full",
                      tone === "rose" && "bg-rose-500",
                      tone === "amber" && "bg-amber-400",
                      tone === "emerald" && "bg-emerald-500"
                    )}
                  />
                )}
                {s.total} зак.
              </span>
            </Link>
          );
        })}
        <Link href={`?day=${shift(day, 1)}`} className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100" aria-label="Следующий день">
          <ChevronRight className="size-4" />
        </Link>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-base font-semibold text-slate-800">
          {fmtDeliveryDateLong(`${day}T00:00:00Z`)}
          {day === today && <span className="ml-2 text-sm font-normal text-slate-500">сегодня</span>}
        </h2>
        {!isPast && <MorningClosureToggle day={day} closed={!!schedule.closure} note={schedule.closure?.note ?? null} />}
      </div>

      {sites.length > 0 && (
        <Card className="p-4">
          <div className="mb-2 text-sm font-medium text-slate-700">Что ИИ сейчас отвечает клиентам про утро</div>
          <div className="flex flex-wrap gap-2">
            {sites.map((s) => (
              <span key={s.site} className={cn("inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm ring-1", VERDICT_TONE[s.verdict])}>
                <b className="font-semibold">{s.site}</b>
                {SITE_VERDICT[s.verdict]}
              </span>
            ))}
          </div>
        </Card>
      )}

      {schedule.florists.length === 0 && schedule.unassigned.length === 0 ? (
        <Card className="p-6 text-center text-sm text-slate-500">На этот день заказов нет.</Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {schedule.florists.map((f) => (
            <FloristColumn key={f.id} florist={f} isPast={isPast} closed={!!schedule.closure} />
          ))}
        </div>
      )}

      {schedule.unassigned.length > 0 && (
        <Card className="p-4">
          <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-amber-700">
            <UserX className="size-4" /> Без флориста — в загрузку не считаются
          </div>
          <OrderRows orders={schedule.unassigned} />
        </Card>
      )}
    </div>
  );
}

/** Коротко и без баллов: владелец читает это как светофор. */
const SITE_VERDICT: Record<MorningVerdict, string> = {
  FIRST: "утро свободно · к 12:00",
  AVAILABLE: "утро есть · к 13:00–15:00",
  FULL: "утро закрыто",
};

const VERDICT_TONE: Record<MorningVerdict, string> = {
  FIRST: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  AVAILABLE: "bg-amber-50 text-amber-700 ring-amber-200",
  FULL: "bg-rose-50 text-rose-700 ring-rose-200",
};

function FloristColumn({ florist: f, isPast, closed }: { florist: FloristDay; isPast: boolean; closed: boolean }) {
  const ratio = f.capacity > 0 ? f.morningPoints / f.capacity : 1;
  const barTone = closed || ratio >= 1 ? "bg-rose-500" : ratio >= 0.75 ? "bg-amber-400" : "bg-emerald-500";
  const lateCount = f.morning.filter((o) => o.late).length;

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="font-medium text-slate-800">{f.name}</span>
          {f.dayOff && <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">выходной</span>}
        </div>
        <CapacityStepper floristId={f.id} capacity={f.capacity} />
      </div>

      {/* Загрузка утра */}
      <div className="mt-3">
        <div className="flex items-baseline justify-between text-xs text-slate-500">
          <span className="flex items-center gap-1">
            <Sun className="size-3.5 text-amber-500" /> Утро: <b className="text-slate-800">{f.morningPoints}</b> из {f.capacity} баллов
          </span>
          {isPast ? (
            lateCount > 0 && <span className="text-rose-600">опозданий: {lateCount}</span>
          ) : (
            <span className={cn("rounded-full px-2 py-0.5 ring-1", VERDICT_TONE[f.verdict])}>новому клиенту: {VERDICT_LABEL[f.verdict]}</span>
          )}
        </div>
        <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-slate-100">
          <div className={cn("h-full rounded-full", barTone)} style={{ width: `${Math.min(100, ratio * 100)}%` }} />
        </div>
      </div>

      <div className="mt-3">
        {f.morning.length ? <OrderRows orders={f.morning} /> : <p className="text-xs text-slate-400">Утренних заказов нет.</p>}
      </div>

      {f.later.length > 0 && (
        <div className="mt-3 border-t border-slate-100 pt-2">
          <div className="mb-1 flex items-center gap-1 text-xs text-slate-500">
            <Moon className="size-3.5" /> После 15:00 — {f.later.length}
          </div>
          <OrderRows orders={f.later} muted />
        </div>
      )}
    </Card>
  );
}

function OrderRows({ orders, muted }: { orders: ScheduleOrder[]; muted?: boolean }) {
  return (
    <ul className="divide-y divide-slate-100">
      {orders.map((o) => (
        <li key={o.id} className={cn("flex flex-wrap items-center gap-x-3 gap-y-0.5 py-1.5 text-sm", muted && "text-slate-500")}>
          <Link href={`/dashboard/orders/${o.id}`} className="font-medium text-slate-800 hover:underline">
            {o.orderNumber}
          </Link>
          {!o.orderNumber.startsWith(o.site) && <span className="text-xs text-slate-400">{o.site}</span>}
          <span className="flex items-center gap-1 text-xs">
            {o.bouquets}
            {o.big && (
              <span className="rounded bg-violet-100 px-1 text-[10px] font-semibold uppercase text-violet-700" title={`Букет от $${BIG_BOUQUET_PRICE}`}>
                большой
              </span>
            )}
            <span className="text-slate-400">· {o.points} б.</span>
          </span>
          <span className="text-xs text-slate-500">окно {o.window}</span>
          {o.wish && <span className="text-xs text-sky-700">клиент: {o.wish}</span>}
          <span className="ml-auto text-xs">
            {o.deliveredAt ? (
              <span className={cn("font-medium", o.late ? "text-rose-600" : "text-emerald-600")}>
                доставлен {o.deliveredAt}
                {o.late && " · опоздали"}
              </span>
            ) : o.status === "DELIVERED" ? (
              <span className="text-emerald-600">доставлен</span>
            ) : (
              <span className="text-slate-400">в работе</span>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}
