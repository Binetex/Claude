import "dotenv/config";
/**
 * Разовая починка заказчика у Shopify-заказов, принятых по старому правилу.
 *
 * Старое правило брало имя и телефон из платёжного адреса, а `customer` шёл лишь запасным.
 * Платёжный адрес заполнен почти всегда, поэтому у заказов, где клиент подставил туда
 * данные ПОЛУЧАТЕЛЯ, телефон заказчика не сохранялся вовсе (PAR-41318).
 *
 * Правка приёма чинит только новые заказы и те, по которым придёт вебхук. Этот скрипт
 * догоняет уже принятые: перечитывает заказ в Shopify и применяет то же самое правило —
 * своей логики здесь нет, вызывается общий extractSenderIdentity.
 *
 *   npx tsx scripts/fix-shopify-sender.ts                      # DRY-RUN
 *   npx tsx scripts/fix-shopify-sender.ts --live --confirm     # записать
 *   npx tsx scripts/fix-shopify-sender.ts --order PAR-41318    # один заказ
 *
 * DRY-RUN по умолчанию. Правятся РОВНО ДВА поля — senderName и senderPhone. Адрес,
 * получатель, деньги и статусы не трогаются.
 */
import { prisma } from "@/lib/db";
import { resolveShopifyAccessToken } from "@/integrations/shopify/customApp/credentials";
import { extractSenderIdentity } from "@/integrations/shopify/orderFields";

const args = process.argv.slice(2);
const live = args.includes("--live") && args.includes("--confirm");
const only = args.includes("--order") ? args[args.indexOf("--order") + 1] : undefined;

type ShopifyOrderPayload = Parameters<typeof extractSenderIdentity>[0];

async function main() {
  const orders = await prisma.order.findMany({
    where: {
      platform: "SHOPIFY",
      externalId: { not: null },
      ...(only ? { orderNumber: only } : {}),
    },
    select: { id: true, orderNumber: true, externalId: true, siteId: true, senderName: true, senderPhone: true },
    orderBy: { externalCreatedAt: "desc" },
  });
  console.log(`Shopify-заказов к проверке: ${orders.length}`);

  const bySite = new Map<string, typeof orders>();
  for (const o of orders) bySite.set(o.siteId, [...(bySite.get(o.siteId) ?? []), o]);

  const planned: { id: string; orderNumber: string; from: string; to: string; name: string; phone: string }[] = [];
  let unreachable = 0;

  for (const [siteId, siteOrders] of bySite) {
    let creds: { shopDomain: string; accessToken: string };
    try {
      creds = await resolveShopifyAccessToken(siteId);
    } catch (e) {
      console.error(`  магазин ${siteId}: нет доступа (${e instanceof Error ? e.message : String(e)}) — пропускаю ${siteOrders.length} заказов`);
      unreachable += siteOrders.length;
      continue;
    }

    for (const o of siteOrders) {
      const r = await fetch(`https://${creds.shopDomain}/admin/api/2025-01/orders/${o.externalId}.json`, {
        headers: { "X-Shopify-Access-Token": creds.accessToken },
      });
      if (!r.ok) {
        console.error(`  ${o.orderNumber}: Shopify ${r.status} — пропускаю`);
        unreachable++;
        continue;
      }
      const { order } = (await r.json()) as { order: ShopifyOrderPayload };
      const next = extractSenderIdentity(order);
      if (next.senderName === o.senderName && next.senderPhone === o.senderPhone) continue;
      planned.push({
        id: o.id,
        orderNumber: o.orderNumber,
        from: `${o.senderName} · ${o.senderPhone || "—"}`,
        to: `${next.senderName} · ${next.senderPhone || "—"}`,
        name: next.senderName,
        phone: next.senderPhone,
      });
    }
  }

  console.log(`\nК изменению: ${planned.length}${unreachable ? `, недоступно в Shopify: ${unreachable}` : ""}`);
  for (const p of planned.slice(0, 30)) {
    console.log(`  ${p.orderNumber}`);
    console.log(`    было:  ${p.from}`);
    console.log(`    стало: ${p.to}`);
  }
  if (planned.length > 30) console.log(`  … и ещё ${planned.length - 30}`);

  if (!live) {
    console.log("\nDRY-RUN. Для записи: --live --confirm");
    return;
  }

  let updated = 0;
  for (const p of planned) {
    // Пишем сохранённые значения, а не разбираем обратно строку показа: имя может
    // содержать что угодно, включая разделитель.
    await prisma.order.update({ where: { id: p.id }, data: { senderName: p.name, senderPhone: p.phone } });
    updated++;
  }
  console.log(`\nОбновлено: ${updated}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
