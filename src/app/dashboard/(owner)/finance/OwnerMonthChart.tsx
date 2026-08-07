"use client";
/**
 * Куда уходит выручка по дням месяца.
 *
 * Отвечает не на тот вопрос, что список под ним: список показывает день строкой с
 * блокерами и ссылками, график — как месяц шёл в целом и в какие дни доля флористов или
 * расходы съедали прибыль.
 *
 * Стопка выбрана так, что её высота — это ВЫРУЧКА дня: флористы + расходы + прибыль
 * складываются в неё ровно (`ownerNet = revenue − expenses − floristEarnings`, см.
 * ownerDashboard.ts). Поэтому картинка не вводит нового числа и разойтись с карточками
 * сверху не может.
 *
 * Два honest-случая, о которых стоит знать:
 *
 *  1. НЕПОСЧИТАННЫЙ день даёт нули, а не частичную стопку. У такого дня расходы заведомо
 *     неполные, и нарисовать их значило бы показать прибыль больше настоящей. Это то же
 *     правило, по которому живёт весь модуль: день считается целиком или не считается.
 *     Тултип такого дня прямо говорит, что день не посчитан.
 *  2. УБЫТОЧНЫЙ день рисует прибыль ниже нуля. Верх стопки тогда перестаёт равняться
 *     выручке — и это правильно: такой день и должен бросаться в глаза, а точные суммы
 *     всегда есть в тултипе.
 */
import { StackedChart } from "@/components/charts/StackedChart";
import { CHART_SERIES } from "@/components/charts/theme";
import { formatDayLabel } from "@/components/charts/theme";
import { eachDay, fullDayLabel } from "@/modules/finance/period";
import { pluralOrders } from "@/modules/finance/earningsFormat";
import type { OwnerDay } from "@/modules/finance/ownerDashboard";

/**
 * Цвета фиксированы за смыслом, а не за местом в серии: расход тёплый, прибыль бирюзовая,
 * доля флористов — индиго, тот же, что у них на своей странице.
 */
const SERIES = [
  { key: "florists", name: "Флористы", color: CHART_SERIES[0] },
  { key: "expenses", name: "Расходы", color: CHART_SERIES[4] },
  { key: "profit", name: "Моя прибыль", color: CHART_SERIES[2] },
];

export function OwnerMonthChart({ days, from, to }: { days: OwnerDay[]; from: string; to: string }) {
  const byDay = new Map(days.map((d) => [d.day, d]));

  // Дни без заказов `getOwnerMonth` не возвращает вовсе — список показывает работу, а не
  // календарь. Графику календарь нужен: без него ось времени рвётся и выходной выглядит
  // как «этого дня не было».
  const points = eachDay(new Date(from), new Date(to)).map((day) => {
    const d = byDay.get(day);
    const ready = d?.ready === true && d.ownerNetCents !== null;
    return {
      day,
      label: formatDayLabel(day),
      orders: d?.ordersTotal ?? 0,
      ready: ready ? 1 : 0,
      florists: ready ? d!.floristEarningsCents : 0,
      expenses: ready ? d!.expensesCents : 0,
      profit: ready ? d!.ownerNetCents! : 0,
    };
  });

  return (
    <StackedChart
      kind="area"
      data={points}
      index="label"
      series={SERIES}
      titleOf={(row) => fullDayLabel(String(row.day))}
      subtitleOf={(row) =>
        Number(row.ready) === 1
          ? pluralOrders(Number(row.orders) || 0)
          : Number(row.orders) > 0
            ? `${pluralOrders(Number(row.orders))} · день не посчитан`
            : "заказов нет"
      }
      totalLabel="выручка за день"
    />
  );
}
