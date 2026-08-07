"use client";
/**
 * Моя прибыль против заработка флористов, по дням месяца.
 *
 * Отвечает не на тот вопрос, что список под ним: список показывает день строкой с
 * блокерами и ссылками, график — как месяц шёл в целом и как делился между мной и
 * флористами.
 *
 * Линии НЕ СЛОЖЕНЫ, и это принципиально: их сравнивают друг с другом. В стопке верхняя
 * линия была бы суммой обеих, и читалась бы как «у флористов сильно больше». Расходов на
 * графике нет намеренно — они не то, что делят между собой эти двое.
 *
 * Два случая, о которых стоит знать:
 *
 *  1. НЕПОСЧИТАННЫЙ день даёт нули, а не половину картины. У такого дня расходы заведомо
 *     неполные, значит и прибыль неизвестна: показать её значило бы соврать в большую
 *     сторону. Это то же правило, по которому живёт весь модуль — день считается целиком
 *     или не считается. Тултип такого дня прямо говорит, что день не посчитан.
 *  2. УБЫТОЧНЫЙ день уводит прибыль ниже нуля — так и должно быть, такой день обязан
 *     бросаться в глаза.
 */
import { DailyChart } from "@/components/charts/DailyChart";
import { CHART_SERIES } from "@/components/charts/theme";
import { formatDayLabel } from "@/components/charts/theme";
import { eachDay, fullDayLabel } from "@/modules/finance/period";
import { pluralOrders } from "@/modules/finance/earningsFormat";
import type { OwnerDay } from "@/modules/finance/ownerDashboard";

/**
 * Цвета фиксированы за смыслом, а не за местом в серии: у флористов индиго — тот же, что
 * на их собственной странице, у моей прибыли бирюзовый.
 */
const SERIES = [
  { key: "profit", name: "Моя прибыль", color: CHART_SERIES[2] },
  { key: "florists", name: "Флористы", color: CHART_SERIES[0] },
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
      profit: ready ? d!.ownerNetCents! : 0,
      florists: ready ? d!.floristEarningsCents : 0,
    };
  });

  return (
    <DailyChart
      kind="area"
      stack={false}
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
      totalLabel="я и флористы вместе"
    />
  );
}
