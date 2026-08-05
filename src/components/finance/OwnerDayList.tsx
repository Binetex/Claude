/**
 * Список дней главного дашборда.
 *
 * Раскладка горизонтальная: дата слева, метрики в ряд, стрелка справа. Вертикальная
 * выписка, которая была раньше, растягивала строку на четыре этажа — четыре дня уже не
 * помещались на экран, а сравнить их между собой можно только видя рядом.
 *
 * Итогов внизу нет: они переехали в карточки над списком, где на них смотрят в первую
 * очередь. Дублировать их ещё и в подвале значило бы показать одно число дважды.
 *
 * Неготовый день не показывает нули. Вместо них — что именно не заполнено, конкретными
 * пунктами: это единственное, что владелец может с этим днём сделать.
 */
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { formatCents } from "@/lib/cents";
import { Badge } from "@/components/ui/Badge";
import type { OwnerDay } from "@/modules/finance/ownerDashboard";

const MONTHS_SHORT = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];

/** Что именно не заполнено. Формулировки — короткие существительные, как в списке дел. */
const MISSING_LABEL: Record<string, string> = {
  DELIVERY_ACTUAL_COST: "стоимость доставки",
  ACQUIRING_FEE: "комиссия эквайринга",
  VASE_GIFT_COST: "закупка ваз и подарков",
  CONSUMABLES_RATE: "ставка расходников",
};

function ordersLabel(n: number): string {
  const last = n % 10;
  const teen = n % 100 >= 11 && n % 100 <= 14;
  if (!teen && last === 1) return `${n} заказ`;
  if (!teen && last >= 2 && last <= 4) return `${n} заказа`;
  return `${n} заказов`;
}

/** Чего не хватает дню: закупка цветов и/или конкретные поля заказов. */
function missingList(day: OwnerDay): string[] {
  const out: string[] = [];
  if (day.blockers.includes("DAILY_FLOWER_EXPENSE_MISSING")) out.push("закупка цветов");
  for (const m of day.missing) out.push(MISSING_LABEL[m] ?? m);
  return out;
}

function Metric({ label, cents, accent = false }: { label: string; cents: number; accent?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="truncate text-xs text-slate-400">{label}</div>
      <div
        className={`mt-0.5 truncate text-sm font-semibold tabular-nums ${
          accent ? (cents < 0 ? "text-red-600" : "text-emerald-600") : "text-slate-900"
        }`}
      >
        {formatCents(cents)}
      </div>
    </div>
  );
}

export function OwnerDayList({ days }: { days: OwnerDay[] }) {
  const pending = days.filter((d) => !d.ready);
  const pendingRevenueCents = pending.reduce((a, d) => a + d.revenueCents, 0);

  return (
    <div>
      <ul className="divide-y divide-slate-100">
        {days.map((d) => {
          const date = new Date(`${d.day}T00:00:00.000Z`);
          const missing = missingList(d);
          return (
            <li key={d.day}>
              <Link
                href={`/dashboard/finance/day/${d.day}`}
                // Прозрачная рамка слева заранее: на hover она красится, и строка не
                // дёргается от появления границы.
                className="flex items-center gap-4 border-l-2 border-transparent px-4 py-3 transition-colors hover:border-emerald-500 hover:bg-slate-50/60"
              >
                <div className="w-9 shrink-0 text-center">
                  <div className="text-lg leading-none font-semibold text-slate-900">{date.getUTCDate()}</div>
                  <div className="mt-0.5 text-xs text-slate-400">{MONTHS_SHORT[date.getUTCMonth()]}</div>
                </div>

                <div className="hidden w-24 shrink-0 text-xs text-slate-400 sm:block">
                  {ordersLabel(d.ordersTotal)}
                </div>

                {d.ownerNetCents == null ? (
                  <div className="min-w-0 flex-1">
                    <Badge className="border-amber-200 bg-amber-50 text-amber-800">Не готов к расчёту</Badge>
                    <div className="mt-1.5 text-xs text-slate-600">Не хватает данных</div>
                    <ul className="mt-0.5 list-disc pl-5 text-xs text-slate-500">
                      {missing.map((m) => (
                        <li key={m}>{m}</li>
                      ))}
                    </ul>
                    <div className="mt-1 text-xs text-slate-400 sm:hidden">{ordersLabel(d.ordersTotal)}</div>
                  </div>
                ) : (
                  <div className="grid min-w-0 flex-1 grid-cols-2 gap-x-4 gap-y-2.5 sm:grid-cols-4 sm:gap-x-6">
                    <Metric label="Выручка" cents={d.revenueCents} />
                    <Metric label="Расходы" cents={d.expensesCents} />
                    <Metric label="Флористы" cents={d.floristEarningsCents} />
                    <Metric label="Моя прибыль" cents={d.ownerNetCents} accent />
                  </div>
                )}

                <ChevronRight aria-hidden className="size-4 shrink-0 text-slate-300" />
              </Link>
            </li>
          );
        })}
      </ul>

      {/* Единственная оставшаяся подпись: без неё непонятно, почему итоги наверху меньше
          суммы видимых дней. Появляется, только когда есть что объяснять. */}
      {pending.length > 0 && (
        <p className="border-t border-slate-100 px-4 py-2.5 text-xs text-amber-700">
          Не готово дней: {pending.length} — их выручка {formatCents(pendingRevenueCents)} в итоги не вошла.
        </p>
      )}
    </div>
  );
}
