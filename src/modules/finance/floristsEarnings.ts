import "server-only";
/**
 * Обзор заработка флористов за период: сколько заработал каждый и в какие дни.
 *
 * СВОЕЙ ФОРМУЛЫ ЗДЕСЬ НЕТ и появиться не должно. Это чтение уже посчитанного, разложенное
 * по дням:
 *  - у основного (PRIMARY) заработок дня — доля от прибыли ПОСЧИТАННОГО дня, ровно та же
 *    `dayShareCents`, что и в `balance.ts`;
 *  - у второстепенного (SECONDARY) — сумма снимков `Order.floristTotal` его доставленных
 *    заказов за этот день, с тем же отсечением отрицательных.
 *
 * Сложи дни за период — получишь `earnedCents` из `balance.ts`. Второго способа посчитать
 * заработок не заводим: он немедленно разошёлся бы с колонкой «Начислено» в таблице ниже.
 *
 * Удержания (доп. расходы второстепенного) здесь НЕ вычитаются — как и в колонке
 * «Начислено». Это обзор заработка, а не расчёт долга: долг живёт в `balance.ts` и
 * показывается столбцом «К выплате».
 */
import { prisma } from "@/lib/db";
import { toNumber } from "@/lib/money";
import { dayShareCents } from "./dayCalc";
import { accrualGate, primaryShareGate } from "./config";
import { listCurrentProfiles } from "./profile";
import { eachDay } from "./period";
import { formatDayLabel, seriesColor } from "@/components/charts/theme";
import { todayStrInTz } from "@/lib/tz";

/**
 * Флорист на графике. Цвет приходит С СЕРВЕРА и закреплён навсегда: он берётся из позиции в
 * ПОЛНОМ списке флористов по дате создания. Считать цвет по месту в серии нельзя — флорист
 * без заработка за период из серии выпадает и перекрашивает всех следующих, из-за чего при
 * смене периода цвета «скачут».
 *
 * Новый флорист получает следующий свободный цвет и никого не сдвигает.
 */
export type FloristSeries = { floristId: string; name: string; color: string };

/**
 * Один КАЛЕНДАРНЫЙ день периода. Заработок флориста лежит под ключом-floristId: так область
 * собирается из серий без второго справочника, а имена (они могут совпадать) ключами не
 * работают.
 *
 * Дни без заработка присутствуют с нулями — иначе ось времени рвётся и выходной выглядит
 * как «этого дня не было».
 */
export type FloristDailyPoint = {
  day: string;
  /** Подпись оси: «6 авг». */
  label: string;
  /** Заработок всех флористов за день. */
  total: number;
  /** Сколько заказов в этот день — для тултипа. */
  orders: number;
} & Record<string, number | string>;

export type FloristEarningsRow = {
  floristId: string;
  earnedCents: number;
  orders: number;
};

export type FloristsEarnings = {
  earnedCents: number;
  ordersTotal: number;
  /** Средний заработок на заказ. Ноль заказов — ноль, а не деление на ноль. */
  avgCents: number;
  series: FloristSeries[];
  points: FloristDailyPoint[];
  /** Итоги по флористу за период — для строки списка. */
  byFlorist: Map<string, FloristEarningsRow>;
  /**
   * Что в обзор НЕ попало. Молчать об этом нельзя: и то и другое занижает все три
   * показателя сверху, а причина не видна.
   */
  pending: {
    /** Дни основного, где не хватает данных: заработка у них нет по построению. */
    days: number;
    /** Заказы второстепенных без заданной цены (`floristTotal` = 0). */
    orders: number;
    /**
     * Какие именно дни и заказы. Число само по себе отправляло владельца искать их вручную,
     * хотя ответ у нас есть: «5 дн. без полных данных» не говорит ни какие это дни, ни что
     * в них не заполнено.
     */
    dayList: string[];
    orderList: { id: string; orderNumber: string }[];
  };
};

/** Позднее из двух начал: гейт расчёта или начало выбранного периода. */
const startFrom = (from: Date, gateStart: Date): Date => (from > gateStart ? from : gateStart);

const dayKey = (d: Date): string => d.toISOString().slice(0, 10);

const avgOf = (earnedCents: number, orders: number): number =>
  orders > 0 ? Math.round(earnedCents / orders) : 0;

/** Цена заказа для второстепенного — тот же отсев отрицательных, что в `balance.ts`. */
const orderCents = (floristTotal: unknown): number =>
  Math.max(Math.round(toNumber(floristTotal as never) * 100), 0);

type Cell = { earned: number; orders: number };

/**
 * Заработок всех флористов за период, разложенный по дням.
 *
 * `from`/`to` — UTC-полночь первого и последнего дня (конвенция `Order.deliveryDate`).
 * Приводить их к таймзоне НЕЛЬЗЯ: она уже учтена при записи даты доставки.
 *
 * Гейты (`FINANCE_ACCRUAL_START_DATE`, `FINANCE_PRIMARY_SHARE_START_DATE`) обрезают период
 * снизу так же, как в `balance.ts`: до даты старта расчёта заработка не существует, и
 * показывать по тем дням нули честнее, чем считать их задним числом по нынешним настройкам.
 */
export async function getFloristsEarnings(from: Date, to: Date, now: Date = new Date()): Promise<FloristsEarnings> {
  // «Сегодня» по календарю магазина — та же граница, что и в issues.ts::groupFor. Дни
  // впереди неё — ещё не наступившие предзаказы, а не недостающие данные: считать их
  // «pending» отправляло владельца в «Требует заполнения» за то, что почитить нельзя.
  const today = new Date(`${todayStrInTz(null, now)}T00:00:00.000Z`);

  const [florists, profiles] = await Promise.all([
    prisma.florist.findMany({
      select: { id: true, user: { select: { name: true } } },
      orderBy: { createdAt: "asc" },
    }),
    listCurrentProfiles(),
  ]);

  const nameById = new Map(florists.map((f) => [f.id, f.user.name]));
  // Цвет — по месту в полном списке флористов, поэтому от выбранного периода не зависит.
  const colorById = new Map(florists.map((f, i) => [f.id, seriesColor(i)]));

  // Модель флориста берётся ТЕКУЩАЯ — ровно как в balance.ts. Иначе обзор и колонка
  // «Начислено» под ним считали бы одного и того же человека по разным правилам.
  const primaryIds = new Set<string>();
  const secondaryIds: string[] = [];
  for (const [floristId, p] of profiles) {
    if (p.model === "PRIMARY") primaryIds.add(floristId);
    else secondaryIds.push(floristId);
  }

  const shareGate = primaryShareGate();
  const accrual = accrualGate();

  const [days, orders] = await Promise.all([
    shareGate.enabled && primaryIds.size > 0
      ? prisma.dayFinance.findMany({
          where: {
            day: { gte: startFrom(from, shareGate.startDate), lte: to },
            financeProfile: { model: "PRIMARY", floristId: { in: [...primaryIds] } },
          },
          select: {
            day: true,
            complete: true,
            distributableCents: true,
            ordersTotal: true,
            financeProfile: { select: { floristId: true, sharePercentBp: true } },
          },
        })
      : Promise.resolve([]),
    accrual.enabled && secondaryIds.length > 0
      ? prisma.order.findMany({
          where: {
            currentFloristId: { in: secondaryIds },
            orderStatus: "DELIVERED",
            deliveryDate: { gte: startFrom(from, accrual.startDate), lte: to },
          },
          select: { id: true, orderNumber: true, currentFloristId: true, deliveryDate: true, floristTotal: true },
        })
      : Promise.resolve([]),
  ]);

  // день → флорист → { заработок, заказы }
  const byDay = new Map<string, Map<string, Cell>>();
  const byFlorist = new Map<string, FloristEarningsRow>();
  const pending = { days: 0, orders: 0, dayList: [] as string[], orderList: [] as { id: string; orderNumber: string }[] };

  const add = (day: string, floristId: string, earned: number, orders: number) => {
    const cells = byDay.get(day) ?? new Map<string, Cell>();
    const cell = cells.get(floristId) ?? { earned: 0, orders: 0 };
    cell.earned += earned;
    cell.orders += orders;
    cells.set(floristId, cell);
    byDay.set(day, cells);

    const row = byFlorist.get(floristId) ?? { floristId, earnedCents: 0, orders: 0 };
    row.earnedCents += earned;
    row.orders += orders;
    byFlorist.set(floristId, row);
  };

  for (const d of days) {
    // Неполный день не даёт ни заработка, ни заказов. Считать его заказы значило бы занизить
    // средний заработок на заказ: деньги за них ещё не посчитаны.
    if (!d.complete) {
      // Будущий день (предзаказ) неполон по построению — доставки ещё не было. Это не
      // «недостающие данные», поэтому в pending.days не идёт и в «Требует заполнения» не
      // отправляет: там для него всё равно нечего разбирать.
      if (d.day <= today) {
        pending.days += 1;
        // Один и тот же день считается по каждому профилю флориста — в списке он нужен один раз.
        const key = dayKey(d.day);
        if (!pending.dayList.includes(key)) pending.dayList.push(key);
      }
      continue;
    }
    const share = d.financeProfile.sharePercentBp;
    if (share == null) continue;
    add(dayKey(d.day), d.financeProfile.floristId, dayShareCents(d.distributableCents, share), d.ordersTotal);
  }

  for (const o of orders) {
    if (!o.currentFloristId) continue;
    const cents = orderCents(o.floristTotal);
    // Ноль — это «цена не задана», а не бесплатный заказ: такой заказ в заработок не входит
    // и ждёт разбора.
    if (cents === 0) {
      pending.orders += 1;
      pending.orderList.push({ id: o.id, orderNumber: o.orderNumber });
      continue;
    }
    add(dayKey(o.deliveryDate), o.currentFloristId, cents, 1);
  }

  // В серии попадают только те, у кого за период что-то есть: пустая полоса ничего не
  // сообщает. Порядок по имени — он задаёт порядок стопки и легенды, но НЕ цвет.
  const series: FloristSeries[] = [...byFlorist.keys()]
    .map((floristId) => ({
      floristId,
      name: nameById.get(floristId) ?? floristId,
      color: colorById.get(floristId) ?? seriesColor(0),
    }))
    .sort((a, b) => a.name.localeCompare(b.name, "ru"));

  const points: FloristDailyPoint[] = eachDay(from, to).map((day) => {
    const cells = byDay.get(day);
    const point: FloristDailyPoint = { day, label: formatDayLabel(day), total: 0, orders: 0 };
    for (const s of series) {
      const cell = cells?.get(s.floristId);
      point[s.floristId] = cell?.earned ?? 0;
      point.total += cell?.earned ?? 0;
      point.orders += cell?.orders ?? 0;
    }
    return point;
  });

  const earnedCents = [...byFlorist.values()].reduce((a, r) => a + r.earnedCents, 0);
  const ordersTotal = [...byFlorist.values()].reduce((a, r) => a + r.orders, 0);

  return {
    earnedCents,
    ordersTotal,
    avgCents: avgOf(earnedCents, ordersTotal),
    series,
    points,
    byFlorist,
    pending: {
      ...pending,
      dayList: [...pending.dayList].sort(),
      orderList: [...pending.orderList].sort((a, b) => a.orderNumber.localeCompare(b.orderNumber)),
    },
  };
}
