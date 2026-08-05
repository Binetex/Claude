import "dotenv/config";
/**
 * Разовая чистка уже пришедших записок от мусора магазина: служебного хвоста приложения
 * доставки и HTML-сущностей.
 *
 *   С днём рождения! | Delivery Date: Wed Aug 5 2026 | Delivery Time: 11:30 AM - 5:00 PM
 *   Nick &amp; Laurel
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
 * Чистятся ВСЕ заказы с мусором, включая те, где `cardMessage != originalCardMessage`. Это
 * расхождение не означает правку человеком: `applyUpdateFromShopify` обновляет cardMessage
 * на каждом вебхуке, а originalCardMessage остаётся от создания заказа. Такие заказы
 * показываются отдельным списком — просто чтобы было видно, что они затронуты.
 *
 * Сама операция безопасна по построению: она убирает только известный служебный хвост и
 * раскрывает сущности, слов клиента не трогает вовсе.
 *
 * Полную синхронизацию заказов для этого использовать нельзя: она перетирает локальные поля.
 */
import { prisma } from "@/lib/db";
import { cleanCardMessage } from "@/integrations/cardMessageTail";

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

  const planned: { id: string; orderNumber: string; site: string; from: string; to: string; original: string }[] = [];
  const diverged: string[] = [];
  let withTail = 0;
  let withEntities = 0;

  for (const o of orders) {
    const cleaned = cleanCardMessage(o.cardMessage);
    if (cleaned === o.cardMessage) continue;
    if (/\|\s*delivery\s+(date|time|window)\s*:/i.test(o.cardMessage)) withTail++;
    if (/&(amp|lt|gt|quot|apos|nbsp|#0?39|#34|[lr]squo|[lr]dquo|mdash|ndash|hellip);/.test(o.cardMessage)) withEntities++;
    const site = `${o.site.name} (${o.site.platform})`;
    if (o.cardMessage !== o.originalCardMessage) diverged.push(o.orderNumber);
    planned.push({ id: o.id, orderNumber: o.orderNumber, site, from: o.cardMessage, to: cleaned, original: o.originalCardMessage });
  }

  console.log(`Просмотрено заказов с непустой запиской: ${orders.length}`);
  console.log(`К изменению: ${planned.length} (хвост: ${withTail}, сущности: ${withEntities})`);

  const bySite = new Map<string, number>();
  for (const p of planned) bySite.set(p.site, (bySite.get(p.site) ?? 0) + 1);
  for (const [site, n] of [...bySite].sort((a, b) => b[1] - a[1])) console.log(`  ${site}: ${n}`);

  if (diverged.length > 0) {
    console.log(`\nИз них с cardMessage != originalCardMessage (${diverged.length}): ${diverged.join(", ")}`);
  }

  if (planned.length === 0) {
    console.log("\nЧистить нечего.");
    return;
  }

  console.log(`\nПримеры:`);
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
  // Сравниваем со СНИМКОМ originalCardMessage до записи: у части заказов он и до прогона
  // отличался от cardMessage (вебхук обновляет одно, не трогая другое).
  const originalChanged = after.filter((a) => a.originalCardMessage !== planned.find((p) => p.id === a.id)!.original);
  const tailLeft = after.filter((a) => cleanCardMessage(a.cardMessage) !== a.cardMessage);

  console.log(`Проверка: originalCardMessage изменился у ${originalChanged.length} (ожидается 0)`);
  console.log(`Проверка: мусор остался у ${tailLeft.length} (ожидается 0)`);
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
