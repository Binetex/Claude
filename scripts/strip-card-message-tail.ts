import "dotenv/config";
/**
 * Разовая чистка уже пришедших записок от служебного хвоста приложения доставки:
 *
 *   С днём рождения! | Delivery Date: Wed Aug 5 2026 | Delivery Time: 11:30 AM - 5:00 PM
 *
 * На новые заказы это уже не действует — хвост срезается на приёме (см.
 * shopify/ingestOrder.ts). Скрипт нужен только для заказов, пришедших ДО той правки.
 *
 *   npx tsx scripts/strip-card-message-tail.ts                    # DRY-RUN: что изменится
 *   npx tsx scripts/strip-card-message-tail.ts --live --confirm   # записать
 *
 * DRY-RUN по умолчанию. Правится РОВНО ОДНО поле — `cardMessage`. `originalCardMessage`
 * не трогается никогда: это след того, что прислал магазин, и заодно возможность откатиться
 * без обращения в Shopify.
 *
 * Заказы, где записку уже правили руками (`cardMessage != originalCardMessage`), скрипт НЕ
 * трогает, а показывает отдельным списком: там текст писал человек, и перезаписывать его
 * автоматом нельзя. Если такие найдутся — решать по ним отдельно и вручную.
 *
 * Полную синхронизацию заказов для этого использовать нельзя: она перетирает локальные поля.
 */
import { prisma } from "@/lib/db";
import { stripDeliveryTail } from "@/integrations/cardMessageTail";

const args = process.argv.slice(2);
const live = args.includes("--live") && args.includes("--confirm");

const preview = (s: string) => JSON.stringify(s.length > 90 ? `${s.slice(0, 90)}…` : s);

async function main() {
  const orders = await prisma.order.findMany({
    where: { cardMessage: { not: "" } },
    select: {
      id: true,
      orderNumber: true,
      cardMessage: true,
      originalCardMessage: true,
      site: { select: { name: true, platform: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  const planned: { id: string; orderNumber: string; site: string; from: string; to: string }[] = [];
  const editedByHand: { orderNumber: string; site: string; from: string; to: string }[] = [];

  for (const o of orders) {
    const cleaned = stripDeliveryTail(o.cardMessage);
    if (cleaned === o.cardMessage) continue;
    const site = `${o.site.name} (${o.site.platform})`;
    if (o.cardMessage !== o.originalCardMessage) {
      editedByHand.push({ orderNumber: o.orderNumber, site, from: o.cardMessage, to: cleaned });
      continue;
    }
    planned.push({ id: o.id, orderNumber: o.orderNumber, site, from: o.cardMessage, to: cleaned });
  }

  console.log(`Просмотрено заказов с непустой запиской: ${orders.length}`);
  console.log(`С хвостом: ${planned.length + editedByHand.length}`);

  const bySite = new Map<string, number>();
  for (const p of [...planned, ...editedByHand]) bySite.set(p.site, (bySite.get(p.site) ?? 0) + 1);
  for (const [site, n] of [...bySite].sort((a, b) => b[1] - a[1])) console.log(`  ${site}: ${n}`);

  if (editedByHand.length > 0) {
    console.log(`\nПРОПУЩЕНЫ — записку правили вручную (${editedByHand.length}), разобрать отдельно:`);
    for (const e of editedByHand) console.log(`  ${e.orderNumber}  ${preview(e.from)}`);
  }

  if (planned.length === 0) {
    console.log("\nЧистить нечего.");
    return;
  }

  console.log(`\nК изменению: ${planned.length}. Примеры:`);
  for (const p of planned.slice(0, 10)) {
    console.log(`  ${p.orderNumber}`);
    console.log(`    было:  ${preview(p.from)}`);
    console.log(`    стало: ${preview(p.to)}`);
  }

  if (!live) {
    console.log("\nDRY-RUN. Для записи: --live --confirm");
    return;
  }

  let updated = 0;
  for (const p of planned) {
    await prisma.order.update({ where: { id: p.id }, data: { cardMessage: p.to } });
    updated++;
  }
  console.log(`\nОбновлено: ${updated}`);

  // Инварианты: поле original не сдвинулось, и хвостов больше не осталось.
  const after = await prisma.order.findMany({
    where: { id: { in: planned.map((p) => p.id) } },
    select: { id: true, orderNumber: true, cardMessage: true, originalCardMessage: true },
  });
  const originalChanged = after.filter((a) => {
    const before = planned.find((p) => p.id === a.id)!;
    return a.originalCardMessage !== before.from;
  });
  const tailLeft = after.filter((a) => stripDeliveryTail(a.cardMessage) !== a.cardMessage);

  console.log(`Проверка: originalCardMessage изменился у ${originalChanged.length} (ожидается 0)`);
  console.log(`Проверка: хвост остался у ${tailLeft.length} (ожидается 0)`);
  if (originalChanged.length > 0 || tailLeft.length > 0) {
    console.error("ИНВАРИАНТ НАРУШЕН — разобраться до дальнейших действий.");
    process.exitCode = 1;
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
