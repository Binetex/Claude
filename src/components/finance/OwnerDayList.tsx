/**
 * Список дней главного дашборда.
 *
 * Раскладка горизонтальная: дата слева, метрики в ряд, стрелка справа. Вертикальная
 * выписка, которая была раньше, растягивала строку на четыре этажа — четыре дня уже не
 * помещались на экран, а сравнить их между собой можно только видя рядом.
 *
 * Дни разделены чередующейся заливкой, а не линиями: на телефоне строка занимает четыре
 * этажа, и тонкая линия между ними теряется — глаз перестаёт понимать, где кончается один
 * день и начинается следующий. Заливка держит границу без единого лишнего пикселя.
 *
 * Итогов внизу нет: они переехали в карточки над списком, где на них смотрят в первую
 * очередь. Дублировать их ещё и в подвале значило бы показать одно число дважды.
 *
 * Неготовый день показывает то, что УЖЕ известно (выручка), и прочерк там, где посчитать
 * нечем. Прятать известное было неправильно: заказы в этот день были, деньги пришли, и
 * скрывать это из-за незаполненной комиссии — значит терять картину. А нули вместо
 * неизвестного врали бы, поэтому там прочерк и список того, что нужно заполнить.
 */
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { formatDollars } from "@/lib/cents";
import { shareOfRevenue } from "@/modules/finance/earningsFormat";
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

/**
 * `cents = null` — величину посчитать нечем; прочерк честнее нуля.
 *
 * `shareOfCents` — выручка дня, если рядом с суммой нужна её доля: «$525 (46%)». У самой
 * выручки доли нет намеренно — это та сотня, от которой считаются остальные.
 */
function Metric({
  label,
  cents,
  shareOfCents,
  accent = false,
}: {
  label: string;
  cents: number | null;
  shareOfCents?: number;
  accent?: boolean;
}) {
  const share = shareOfCents == null ? null : shareOfRevenue(cents, shareOfCents);
  return (
    <div className="min-w-0">
      <div className="truncate text-xs text-slate-400">{label}</div>
      <div
        className={`mt-0.5 truncate text-sm font-semibold tabular-nums ${
          cents == null
            ? "text-slate-300"
            : accent
              ? cents < 0
                ? "text-red-600"
                : "text-emerald-600"
              : "text-slate-900"
        }`}
      >
        {cents == null ? "—" : formatDollars(cents)}
        {share && <span className="ml-1 text-[11px] font-normal text-slate-400">({share})</span>}
      </div>
    </div>
  );
}

export function OwnerDayList({ days }: { days: OwnerDay[] }) {
  const pending = days.filter((d) => !d.ready);
  const pendingRevenueCents = pending.reduce((a, d) => a + d.revenueCents, 0);

  return (
    <div>
      <ul>
        {days.map((d) => {
          const date = new Date(`${d.day}T00:00:00.000Z`);
          const missing = missingList(d);
          return (
            <li key={d.day} className="even:bg-slate-50/70">
              <Link
                href={`/dashboard/finance/day/${d.day}`}
                // Прозрачная рамка слева заранее: на hover она красится, и строка не
                // дёргается от появления границы.
                className="flex items-center gap-3 border-l-2 border-transparent px-4 py-3 transition-colors hover:border-emerald-500 hover:bg-slate-100/70 sm:gap-4"
              >
                <div className="w-9 shrink-0 text-center">
                  <div className="text-lg leading-none font-semibold text-slate-900">{date.getUTCDate()}</div>
                  <div className="mt-0.5 text-xs text-slate-400">{MONTHS_SHORT[date.getUTCMonth()]}</div>
                </div>

                <div className="hidden w-24 shrink-0 text-xs text-slate-400 sm:block">
                  {ordersLabel(d.ordersTotal)}
                </div>

                <div className="min-w-0 flex-1">
                  <div className="grid grid-cols-2 gap-x-4 gap-y-2.5 sm:grid-cols-4 sm:gap-x-6">
                    {/* Выручка известна всегда: заказы состоялись, сколько заплатили — видно.
                        Процента у неё нет: остальные три считаются именно от неё. */}
                    <Metric label="Выручка" cents={d.revenueCents} />
                    <Metric label="Расходы" cents={d.ready ? d.expensesCents : null} shareOfCents={d.revenueCents} />
                    <Metric label="Флористы" cents={d.ready ? d.floristEarningsCents : null} shareOfCents={d.revenueCents} />
                    <Metric label="Моя прибыль" cents={d.ownerNetCents} shareOfCents={d.revenueCents} accent />
                  </div>

                  {d.ownerNetCents == null && (
                    <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
                      <Badge className="border-amber-200 bg-amber-50 text-amber-800">Не готов к расчёту</Badge>
                      <span className="text-xs text-slate-500">не хватает: {missing.join(", ")}</span>
                    </div>
                  )}

                  <div className="mt-1 text-xs text-slate-400 sm:hidden">{ordersLabel(d.ordersTotal)}</div>
                </div>

                {/* Стрелка только на большом экране: на телефоне она вместе с отступом
                    отбирала у цифр почти 50px, из-за чего правая колонка липла к краю. */}
                <ChevronRight aria-hidden className="hidden size-4 shrink-0 text-slate-300 sm:block" />
              </Link>
            </li>
          );
        })}
      </ul>

      {/* Единственная оставшаяся подпись: без неё непонятно, почему итоги наверху меньше
          суммы видимых дней. Появляется, только когда есть что объяснять. */}
      {pending.length > 0 && (
        <p className="border-t border-slate-100 px-4 py-2.5 text-xs text-amber-700">
          Не готово дней: {pending.length} — их выручка {formatDollars(pendingRevenueCents)} в итоги не вошла.
        </p>
      )}
    </div>
  );
}
