import "dotenv/config";
import { prisma } from "@/lib/db";
import { syncOrders } from "@/modules/orders/sync";

/**
 * Разовый запуск синхронизации заказов для подключённого Shopify-магазина.
 * По умолчанию берёт первый CONNECTED Shopify-сайт; можно указать --site <domain>.
 *
 * Запуск (server-only модули требуют условие react-server):
 *   NODE_OPTIONS=--conditions=react-server tsx scripts/sync-orders-once.ts [--site example.myshopify.com]
 */
const domainArg = process.argv.indexOf("--site");
const domain = domainArg !== -1 ? process.argv[domainArg + 1] : undefined;

(async () => {
  const site = domain
    ? await prisma.site.findUnique({ where: { shopifyShopDomain: domain } })
    : await prisma.site.findFirst({ where: { connectionStatus: "CONNECTED", platform: "SHOPIFY" } });

  if (!site) {
    console.error("Нет подключённого Shopify-сайта для синхронизации.");
    process.exit(1);
  }

  console.log(`Синхронизирую заказы: ${site.name} (${site.shopifyShopDomain})`);
  await syncOrders(site.id);
  const sync = await prisma.siteSync.findUnique({ where: { siteId_kind: { siteId: site.id, kind: "ORDERS" } } });
  console.log("Результат:", JSON.stringify({ status: sync?.status, total: sync?.total, processed: sync?.processed, created: sync?.created, skipped: sync?.skipped, errors: sync?.errors }));
  await prisma.$disconnect();
})().catch((err) => {
  console.error("Ошибка синхронизации заказов:", err);
  process.exit(1);
});
