/**
 * Список дней главного дашборда.
 *
 * Одна строка — один день и один вывод: сколько осталось. Три слагаемых стоят рядом, чтобы
 * было видно, ИЗ ЧЕГО получилась цифра, но разбирать их здесь не нужно — для этого клик.
 *
 * Ни полосок, ни процентов: они добавляли пестроты и не отвечали ни на один вопрос.
 *
 * Неготовый день честно говорит, что в прибыль месяца не входит. Без этой подписи владелец,
 * добавив расход и не увидев сдвига, решает, что система сломалась.
 */
import Link from "next/link";
import { ChevronRight } from "lucide-react";
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

function ordersLabel(n: number): string {
  const last = n % 10;
  const teen = n % 100 >= 11 && n % 100 <= 14;
  if (!teen && last === 1) return `${n} заказ`;
  if (!teen && last >= 2 && last <= 4) return `${n} заказа`;
  return `${n} заказов`;
}

export function OwnerDayList({ days }: { days: OwnerDay[] }) {
  return (
    <ul className="divide-y divide-slate-100">
      {days.map((d) => (
        <li key={d.day}>
          <Link
            href={`/dashboard/finance/day/${d.day}`}
            className="flex items-start gap-3 px-4 py-3 hover:bg-slate-50/60"
          >
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="font-medium text-slate-900">{dayLabel(d.day)}</span>
                <span className="text-xs text-slate-400">{ordersLabel(d.ordersTotal)}</span>
              </div>

              <dl className="mt-2 max-w-xs space-y-0.5 text-sm">
                <Row label="Выручка" cents={d.revenueCents} />
                <Row label="Расходы" cents={d.expensesCents} />
                <Row label="Флористы" cents={d.floristEarningsCents} />
                <div className="!mt-1 border-t border-slate-200 pt-1">
                  {d.ownerNetCents == null ? (
                    <div className="flex items-center justify-between gap-3">
                      <Badge className="border-amber-200 bg-amber-50 text-amber-800">Не готов к расчёту</Badge>
                      <span className="text-xs text-slate-400">в прибыль месяца не входит</span>
                    </div>
                  ) : (
                    <Row label="Моя прибыль" cents={d.ownerNetCents} strong />
                  )}
                </div>
              </dl>

              {d.ownerNetCents == null && (
                <p className="mt-1 text-xs text-slate-500">
                  {d.blockers.map((b) => BLOCKER_LABEL[b] ?? b).join(", ")}
                </p>
              )}
            </div>

            <div className="flex shrink-0 items-center gap-2 pt-0.5">
              <span
                className={`text-base font-semibold tabular-nums ${
                  d.ownerNetCents == null
                    ? "text-slate-300"
                    : d.ownerNetCents < 0
                      ? "text-red-600"
                      : "text-slate-900"
                }`}
              >
                {d.ownerNetCents == null ? "—" : formatCents(d.ownerNetCents)}
              </span>
              <ChevronRight aria-hidden className="size-4 text-slate-300" />
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function Row({ label, cents, strong = false }: { label: string; cents: number; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className={strong ? "text-slate-700" : "text-slate-500"}>{label}</dt>
      <dd className={`tabular-nums ${strong ? "font-semibold text-slate-900" : "text-slate-700"}`}>
        {formatCents(cents)}
      </dd>
    </div>
  );
}
