import "dotenv/config";
import readline from "readline";
import { prisma } from "@/lib/db";
import { featureFlags } from "@/lib/featureFlags";
import { backfillShopifyOrder, type ShopifyOrder } from "@/integrations/shopify/ingestOrder";
import { createProductImageCache } from "@/integrations/shopify/productImages";

/**
 * Разово подтягивает исторические заказы Shopify (по умолчанию — последние 30 дней)
 * по одному уже подключённому магазину. Импортированные заказы помечаются
 * `isBackfilled: true` и показываются на отдельной вкладке "Старые заказы"
 * (`/dashboard/orders/old`), не смешиваясь с обычной лентой. Проходят обычный
 * пайплайн, включая авто-назначение флориста (см. `backfillShopifyOrder`).
 *
 * Важно: этот скрипт — единственное осознанное отступление от правила "старые
 * заказы не импортируются" (см. CLAUDE.md §7/§11/§18). Обычная Shopify-интеграция
 * (вебхуки) не меняется.
 *
 * Использование:
 *   npm run backfill-shopify-orders -- --site p7mx1v-pz.myshopify.com --days 30 --dry-run
 *   npm run backfill-shopify-orders -- --site p7mx1v-pz.myshopify.com --days 30 --yes
 *
 * ВНИМАНИЕ (Node.js): скрипт импортирует серверные модули приложения, помеченные
 * `import "server-only"`. Запускать ТОЛЬКО через npm-скрипт (см. package.json),
 * который уже проставляет NODE_OPTIONS="--conditions=react-server" — это условие
 * экспорта переключает пакет "server-only" на пустышку вне сборки Next.js
 * (тот же приём, что webpack/Next используют для React Server Components).
 */

const API_VERSION = "2026-07";
const RATE_LIMIT_BUCKET_SIZE = 40;
const RATE_LIMIT_SAFETY_MARGIN = 5;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  return process.argv[i + 1];
}
const hasFlag = (name: string) => process.argv.includes(`--${name}`);

function prompt(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

function parseLinkHeader(header: string | null): string | undefined {
  if (!header) return undefined;
  const next = header.split(",").find((part) => part.includes('rel="next"'));
  if (!next) return undefined;
  const match = next.match(/<([^>]+)>/);
  return match?.[1];
}

async function throttle(res: Response): Promise<void> {
  const header = res.headers.get("X-Shopify-Shop-Api-Call-Limit");
  if (!header) return;
  const [used] = header.split("/").map(Number);
  if (Number.isFinite(used) && used >= RATE_LIMIT_BUCKET_SIZE - RATE_LIMIT_SAFETY_MARGIN) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

async function fetchOrdersPage(url: string, accessToken: string): Promise<{ orders: ShopifyOrder[]; nextUrl?: string }> {
  const res = await fetch(url, { headers: { "X-Shopify-Access-Token": accessToken } });
  if (!res.ok) {
    throw new Error(`Shopify REST ${res.status}: ${await res.text()}`);
  }
  await throttle(res);
  const body = (await res.json()) as { orders: ShopifyOrder[] };
  const nextUrl = parseLinkHeader(res.headers.get("Link"));
  return { orders: body.orders ?? [], nextUrl };
}

async function fetchAllOrders(shopDomain: string, accessToken: string, sinceIso: string): Promise<ShopifyOrder[]> {
  const all: ShopifyOrder[] = [];
  let url: string | undefined =
    `https://${shopDomain}/admin/api/${API_VERSION}/orders.json?status=any&created_at_min=${encodeURIComponent(sinceIso)}&limit=250`;

  while (url) {
    const { orders, nextUrl } = await fetchOrdersPage(url, accessToken);
    all.push(...orders);
    url = nextUrl;
  }
  return all;
}

async function main() {
  if (!featureFlags.shopify) {
    console.error("SHOPIFY_ENABLED не включён — backfill не имеет смысла запускать.");
    process.exit(1);
  }

  const shopDomain = arg("site");
  if (!shopDomain) {
    console.error("Укажите магазин: --site <shop>.myshopify.com");
    process.exit(1);
  }

  const days = Number(arg("days") ?? "30");
  if (!Number.isFinite(days) || days <= 0) {
    console.error("Некорректное значение --days (ожидается положительное число).");
    process.exit(1);
  }

  const dryRun = hasFlag("dry-run");
  const nonInteractiveOk = hasFlag("yes");

  const site = await prisma.site.findUnique({ where: { shopifyShopDomain: shopDomain } });
  if (!site) {
    console.error(`Магазин ${shopDomain} не найден (не подключён через /dashboard/sites).`);
    process.exit(1);
  }
  if (site.connectionStatus !== "CONNECTED") {
    console.error(`Магазин ${shopDomain} не в статусе CONNECTED (сейчас: ${site.connectionStatus}).`);
    process.exit(1);
  }
  if (!site.shopifyAccessToken) {
    console.error(`У магазина ${shopDomain} нет сохранённого access token.`);
    process.exit(1);
  }

  const since = new Date();
  since.setDate(since.getDate() - days);
  const sinceIso = since.toISOString();

  console.log(`Забираю заказы ${shopDomain} с ${sinceIso}${dryRun ? " (dry-run, без записи в БД)" : ""}...`);
  const orders = await fetchAllOrders(shopDomain, site.shopifyAccessToken, sinceIso);
  console.log(`Найдено заказов в Shopify: ${orders.length}`);

  if (!dryRun && !nonInteractiveOk) {
    const confirm = await prompt(`Импортировать ${orders.length} заказ(ов) в "${site.name}" как старые (isBackfilled)? (yes/no): `);
    if (confirm.trim().toLowerCase() !== "yes") {
      console.log("Отменено.");
      process.exit(0);
    }
  }

  let created = 0;
  let skipped = 0;
  let errors = 0;
  // Один кэш на весь прогон — не запрашиваем повторно картинку одного и того же товара,
  // если он встречается в нескольких исторических заказах (см. productImages.ts).
  const imageCache = createProductImageCache();

  for (const payload of orders) {
    if (dryRun) {
      console.log(`[dry-run] заказ ${payload.name ?? payload.id} — был бы импортирован (если ещё не существует)`);
      continue;
    }
    try {
      const result = await backfillShopifyOrder(site, payload, imageCache);
      if (result.status === "created") created++;
      else skipped++;
    } catch (err) {
      errors++;
      console.error(`Заказ ${payload.name ?? payload.id}: ошибка —`, err instanceof Error ? err.message : err);
    }
  }

  if (!dryRun) {
    console.log(`Готово. Создано: ${created}, пропущено (уже существуют): ${skipped}, ошибок: ${errors}.`);
  }
}

main()
  .catch((e) => {
    console.error("Ошибка:", e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
