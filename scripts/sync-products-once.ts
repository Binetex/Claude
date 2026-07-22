import "dotenv/config";
import { prisma } from "@/lib/db";
import { syncProducts } from "@/modules/catalog/sync";

/**
 * Разовый запуск синхронизации каталога для подключённого Shopify-магазина.
 * По умолчанию берёт первый CONNECTED Shopify-сайт; можно указать --site <domain>.
 *
 * Запуск (server-only модули требуют условие react-server, см. backfill-скрипт):
 *   NODE_OPTIONS=--conditions=react-server tsx scripts/sync-products-once.ts [--site example.myshopify.com]
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

  console.log(`Синхронизирую каталог: ${site.name} (${site.shopifyShopDomain})`);
  const res = await syncProducts(site.id);
  console.log("Результат синхронизации:", JSON.stringify(res));
  await prisma.$disconnect();
})().catch((err) => {
  console.error("Ошибка синхронизации:", err);
  process.exit(1);
});
