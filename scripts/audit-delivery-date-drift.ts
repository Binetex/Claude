/**
 * ДИАГНОСТИКА (только чтение): у каких заказов день доставки съехал из-за старого приёма.
 *
 * ЗАЧЕМ. `Order.deliveryDate` по контракту — UTC-полночь ЛОКАЛЬНОГО дня магазина. Приём заказа
 * без явной даты доставки клал туда сырую отметку времени создания заказа, поэтому у вечерних
 * заказов (после 17:00 в Лос-Анджелесе — это уже следующие сутки UTC) день оказывался
 * завтрашним. Путь записи исправлен; этот скрипт отвечает, сколько строк осталось в БД и
 * насколько они разъехались.
 *
 * КАК ОПРЕДЕЛЯЮТСЯ ПОСТРАДАВШИЕ. Признак железный: у корректной строки время ровно 00:00:00.000
 * UTC. Любой остаток времени = значение записано старым фолбэком. Дальше сравниваем календарный
 * день этой отметки в таймзоне магазина с тем днём, который сейчас видит система (UTC-дата):
 * различаются — заказ реально показывается не тем днём.
 *
 * ЭТОТ СКРИПТ НИЧЕГО НЕ ПИШЕТ. Ни update, ни delete, ни create — только findMany/count.
 * Решение о правке истории принимает владелец отдельно.
 */
import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { localDateStr, DEFAULT_STORE_TZ } from "../src/lib/tz";

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });

function isUtcMidnight(d: Date): boolean {
  return d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0 && d.getUTCMilliseconds() === 0;
}

async function main() {
  const orders = await prisma.order.findMany({
    select: {
      id: true,
      orderNumber: true,
      deliveryDate: true,
      createdAt: true,
      orderStatus: true,
      site: { select: { name: true, shortName: true, timezone: true } },
    },
    orderBy: { deliveryDate: "asc" },
  });

  console.log(`Всего заказов: ${orders.length}`);

  const withTime = orders.filter((o) => o.deliveryDate && !isUtcMidnight(o.deliveryDate));
  console.log(`Дата доставки записана отметкой времени (не полночь): ${withTime.length}`);

  if (withTime.length === 0) {
    console.log("Съехавших строк нет — история чистая.");
    return;
  }

  const shifted: typeof withTime = [];
  const sameDay: typeof withTime = [];
  for (const o of withTime) {
    const shownDay = o.deliveryDate!.toISOString().slice(0, 10); // как систему видит сейчас
    const realDay = localDateStr(o.deliveryDate!, o.site.timezone || DEFAULT_STORE_TZ); // как должно быть
    (shownDay === realDay ? sameDay : shifted).push(o);
  }

  console.log(`  из них показываются НЕ ТЕМ днём: ${shifted.length}`);
  console.log(`  из них день совпадает (сдвига нет, но значение не полночь): ${sameDay.length}`);

  const byStore = new Map<string, number>();
  const byStatus = new Map<string, number>();
  let oldest: Date | null = null;
  let newest: Date | null = null;
  for (const o of shifted) {
    const store = o.site.shortName || o.site.name;
    byStore.set(store, (byStore.get(store) ?? 0) + 1);
    byStatus.set(o.orderStatus, (byStatus.get(o.orderStatus) ?? 0) + 1);
    if (!oldest || o.createdAt < oldest) oldest = o.createdAt;
    if (!newest || o.createdAt > newest) newest = o.createdAt;
  }

  if (shifted.length > 0) {
    console.log("\nПо магазинам:");
    for (const [store, n] of [...byStore].sort((a, b) => b[1] - a[1])) console.log(`  ${store}: ${n}`);
    console.log("По статусу заказа:");
    for (const [st, n] of [...byStatus].sort((a, b) => b[1] - a[1])) console.log(`  ${st}: ${n}`);
    console.log(`Диапазон создания: ${oldest?.toISOString().slice(0, 10)} … ${newest?.toISOString().slice(0, 10)}`);

    console.log("\nПримеры (до 15):");
    for (const o of shifted.slice(0, 15)) {
      const shownDay = o.deliveryDate!.toISOString().slice(0, 10);
      const realDay = localDateStr(o.deliveryDate!, o.site.timezone || DEFAULT_STORE_TZ);
      console.log(`  ${o.orderNumber}: система показывает ${shownDay}, должно быть ${realDay} (в БД ${o.deliveryDate!.toISOString()}, ${o.orderStatus})`);
    }
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
