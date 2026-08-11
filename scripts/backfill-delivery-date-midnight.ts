/**
 * Разовая нормализация `Order.deliveryDate` к контракту: UTC-полночь ЛОКАЛЬНОГО дня магазина.
 *
 * ЗАЧЕМ. Старый приём заказа без явной даты доставки клал в поле сырую отметку времени создания
 * заказа. У вечерних заказов (после 17:00 в Лос-Анджелесе — это уже следующие сутки UTC) день
 * получался завтрашним, у остальных день верный, но со временем внутри. Путь записи исправлен;
 * здесь приводится к контракту то, что уже лежит в БД.
 *
 * ЧТО ТРОГАЕТ. Ровно одно поле `deliveryDate` и ровно те строки, где время НЕ равно 00:00:00.000
 * UTC. Ничего не пересчитывает, ничего не удаляет, других полей не касается.
 *
 * ИНВАРИАНТЫ (проверяются перед КАЖДОЙ записью, нарушение = полная остановка без изменений):
 *  1. новое значение — ровно UTC-полночь;
 *  2. день сдвигается не больше чем на одни календарные сутки (нормализация, а не перенос
 *     доставки). Именно в календарных днях, а не в миллисекундах: у отметки «00:00:31 UTC»
 *     локальный день предыдущий, и в миллисекундах такая нормализация выглядит как «минус
 *     24 часа с секундами», хотя день сдвигается ровно на один;
 *  3. у строки действительно было ненулевое время.
 *
 * ФИНАНСЫ не пересчитываются намеренно: день меняется только у заказов ИЮЛЯ, а расчёт заработка
 * начинается с `FINANCE_ACCRUAL_START_DATE` (1 августа) — июльские дни в него не входят. Если
 * набор строк окажется другим, скрипт об этом СКАЖЕТ и остановится (см. проверку ниже).
 *
 * По умолчанию — сухой прогон. Запись только с `--live`.
 */
import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { utcMidnightOfLocalDay, DEFAULT_STORE_TZ } from "../src/lib/tz";

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
const LIVE = process.argv.includes("--live");

/** Дни начиная с этой даты трогать нельзя без пересчёта финансов — там уже считается заработок. */
const FINANCE_GATE = process.env.FINANCE_ACCRUAL_START_DATE || "2026-08-01";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Номер календарных UTC-суток — чтобы сравнивать ДНИ, а не моменты времени. */
function dayIndex(d: Date): number {
  return Math.floor(Date.parse(`${d.toISOString().slice(0, 10)}T00:00:00.000Z`) / DAY_MS);
}

function isUtcMidnight(d: Date): boolean {
  return d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0 && d.getUTCMilliseconds() === 0;
}

async function main() {
  console.log(LIVE ? "РЕЖИМ ЗАПИСИ (--live)" : "СУХОЙ ПРОГОН (записи не будет)");

  const orders = await prisma.order.findMany({
    select: {
      id: true,
      orderNumber: true,
      deliveryDate: true,
      orderStatus: true,
      site: { select: { shortName: true, name: true, timezone: true } },
    },
    orderBy: { deliveryDate: "asc" },
  });

  const targets = orders
    .filter((o) => o.deliveryDate && !isUtcMidnight(o.deliveryDate))
    .map((o) => {
      const from = o.deliveryDate!;
      const to = utcMidnightOfLocalDay(from, o.site.timezone || DEFAULT_STORE_TZ);
      return { ...o, from, to, dayChanges: from.toISOString().slice(0, 10) !== to.toISOString().slice(0, 10) };
    });

  console.log(`Всего заказов: ${orders.length}`);
  console.log(`К нормализации (время не полночь): ${targets.length}`);
  console.log(`  из них меняется ДЕНЬ: ${targets.filter((t) => t.dayChanges).length}`);
  console.log(`  из них только обнуляется время: ${targets.filter((t) => !t.dayChanges).length}`);

  if (targets.length === 0) {
    console.log("Нечего делать.");
    return;
  }

  // Инварианты — до любой записи.
  for (const t of targets) {
    if (!isUtcMidnight(t.to)) throw new Error(`ИНВАРИАНТ 1: ${t.orderNumber}: новое значение не полночь (${t.to.toISOString()})`);
    const dayShift = dayIndex(t.to) - dayIndex(t.from);
    if (Math.abs(dayShift) > 1)
      throw new Error(`ИНВАРИАНТ 2: ${t.orderNumber}: день сдвигается на ${dayShift} сут. — это перенос, а не нормализация`);
    if (isUtcMidnight(t.from)) throw new Error(`ИНВАРИАНТ 3: ${t.orderNumber}: строка и так корректна, трогать нельзя`);
  }

  // Заказ, у которого МЕНЯЕТСЯ ДЕНЬ на дате внутри финансового периода, требует пересчёта дня —
  // руками, отдельным решением. Такие строки останавливают прогон, а не молча уезжают.
  const insideFinance = targets.filter((t) => t.dayChanges && (t.from.toISOString().slice(0, 10) >= FINANCE_GATE || t.to.toISOString().slice(0, 10) >= FINANCE_GATE));
  if (insideFinance.length > 0) {
    console.error(`\nОСТАНОВ: ${insideFinance.length} заказ(ов) меняют день внутри финансового периода (с ${FINANCE_GATE}):`);
    for (const t of insideFinance) console.error(`  ${t.orderNumber}: ${t.from.toISOString().slice(0, 10)} → ${t.to.toISOString().slice(0, 10)}`);
    console.error("Такие строки требуют пересчёта дня (npm run finance:recompute) и отдельного решения владельца.");
    throw new Error("прогон остановлен: затронут финансовый период");
  }

  console.log("\nПострочно (было → станет):");
  for (const t of targets) {
    const mark = t.dayChanges ? "  ДЕНЬ" : "      ";
    console.log(`${mark} ${t.site.shortName || t.site.name} ${t.orderNumber} [${t.orderStatus}]: ${t.from.toISOString()} → ${t.to.toISOString()}`);
  }

  if (!LIVE) {
    console.log("\nСухой прогон окончен. Записи НЕ было. Для записи: --live");
    return;
  }

  let updated = 0;
  for (const t of targets) {
    await prisma.order.update({ where: { id: t.id }, data: { deliveryDate: t.to } });
    updated++;
  }
  console.log(`\nОбновлено строк: ${updated}`);

  // Контроль после записи: не осталось ни одной строки с ненулевым временем.
  const after = await prisma.order.findMany({ select: { id: true, orderNumber: true, deliveryDate: true } });
  const stillBroken = after.filter((o) => o.deliveryDate && !isUtcMidnight(o.deliveryDate));
  console.log(stillBroken.length === 0 ? "Проверка: все даты доставки — ровная UTC-полночь." : `ВНИМАНИЕ: осталось ${stillBroken.length} строк с временем.`);
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
