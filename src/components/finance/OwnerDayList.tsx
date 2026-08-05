/**
 * Список дней главного финансового дашборда.
 *
 * Три числа на день и полоска, показывающая долю чистого дохода в выручке, — чтобы
 * удачные и неудачные дни различались с одного взгляда, без диаграмм и библиотек.
 *
 * Неготовый день показывается как «Не готов к расчёту», а не как ноль: дыра в данных не
 * должна выглядеть убытком. Причины перечислены рядом, чтобы было понятно, что заполнить.
 */
import { formatCents } from "@/lib/cents";
import { Badge } from "@/components/ui/Badge";
import type { OwnerDay } from "@/modules/finance/ownerDashboard";

const MONTHS_GENITIVE = [
  "января", "февраля", "марта", "апреля", "мая", "июня",
  "июля", "августа", "сентября", "октября", "ноября", "декабря",
];

const BLOCKER_LABEL: Record<string, string> = {
  DAILY_FLOWER_EXPENSE_MISSING: "не внесена закупка цветов",
  ORDER_DATA_INCOMPLETE: "по заказам не хватает данных",
};

function dayLabel(iso: string): string {
  const d = new Date(`${iso}T00:00:00.000Z`);
  return `${d.getUTCDate()} ${MONTHS_GENITIVE[d.getUTCMonth()]}`;
}

/** Доля чистого дохода в выручке дня — только для ширины полоски. */
function netShare(day: OwnerDay): number {
  if (day.ownerNetCents == null || day.revenueCents <= 0) return 0;
  return Math.max(0, Math.min(1, day.ownerNetCents / day.revenueCents));
}

export function OwnerDayList({ days }: { days: OwnerDay[] }) {
  return (
    <ul className="divide-y divide-slate-100">
      {days.map((d) => (
        <li key={d.day} className="px-4 py-3">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <span className="font-medium text-slate-900">{dayLabel(d.day)}</span>
            <span className="text-xs text-slate-400">
              {d.ordersTotal} {d.ordersTotal === 1 ? "заказ" : d.ordersTotal < 5 ? "заказа" : "заказов"}
            </span>
          </div>

          {d.ready ? (
            <>
              <div className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-3">
                <Line label="Доход бизнеса" cents={d.revenueCents} />
                <Line label="Мой чистый доход" cents={d.ownerNetCents ?? 0} strong />
                <Line label="Доход флористов" cents={d.floristEarningsCents} />
              </div>

              {/* Полоска — доля чистого в выручке. Ширина, а не число: сравнивать дни
                  глазами быстрее, чем читать проценты. */}
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-100">
                <div
                  className={(d.ownerNetCents ?? 0) >= 0 ? "h-full bg-emerald-400" : "h-full bg-red-400"}
                  style={{ width: `${Math.round(netShare(d) * 100)}%` }}
                />
              </div>
            </>
          ) : (
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <Badge className="border-amber-200 bg-amber-50 text-amber-800">Не готов к расчёту</Badge>
              <span className="text-xs text-slate-500">
                {d.blockers.map((b) => BLOCKER_LABEL[b] ?? b).join(", ")}
              </span>
              <span className="ml-auto text-xs tabular-nums text-slate-400">
                выручка {formatCents(d.revenueCents)}
              </span>
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

function Line({ label, cents, strong = false }: { label: string; cents: number; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-2 sm:block">
      <span className="text-xs text-slate-400">{label}</span>
      <span
        className={`tabular-nums sm:mt-0.5 sm:block ${
          strong ? "text-base font-semibold text-slate-900" : "text-sm text-slate-700"
        }`}
      >
        {formatCents(cents)}
      </span>
    </div>
  );
}
