/**
 * Разово раскладывает текст окна старых заказов в строгие «с — до» (Order.windowFrom/windowTo).
 *
 * Трогает ТОЛЬКО заказы без чисел и пишет ТОЛЬКО два числа: текст окна остаётся как был — это
 * история заказа, её не переписываем. Не разобралось («желательно первым», «—») — остаётся без
 * окна, в карточке такой заказ видно как «время не задано».
 *
 * По умолчанию — сухой прогон: печатает, что сделал бы. Запись — с флагом --apply.
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/backfill-order-windows.ts
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/backfill-order-windows.ts --apply
 */
import { prisma } from "../src/lib/db";
import { parseWindowText, formatWindowText } from "../src/lib/deliveryWindow";

async function main() {
  const apply = process.argv.includes("--apply");
  const rows = await prisma.order.findMany({
    where: { OR: [{ windowFrom: null }, { windowTo: null }] },
    select: { id: true, orderNumber: true, deliveryWindow: true },
  });

  const unparsed = new Map<string, number>();
  const samples = new Map<string, string>();
  let parsed = 0;
  for (const r of rows) {
    const range = parseWindowText(r.deliveryWindow);
    if (!range) {
      const key = r.deliveryWindow.trim() || "(пусто)";
      unparsed.set(key, (unparsed.get(key) ?? 0) + 1);
      continue;
    }
    parsed++;
    if (!samples.has(r.deliveryWindow)) samples.set(r.deliveryWindow, formatWindowText(range));
    if (apply) await prisma.order.update({ where: { id: r.id }, data: { windowFrom: range.from, windowTo: range.to } });
  }

  console.log(`${apply ? "ЗАПИСАНО" : "СУХОЙ ПРОГОН"}: заказов без окна-чисел ${rows.length}, разложено ${parsed}, не разобралось ${rows.length - parsed}`);
  console.log("\nКак разобрались разные записи:");
  for (const [raw, out] of samples) console.log(`  «${raw}» → ${out}`);
  console.log("\nНе разобрались (останутся «время не задано»):");
  for (const [raw, n] of [...unparsed].sort((a, b) => b[1] - a[1])) console.log(`  «${raw}» — ${n}`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
