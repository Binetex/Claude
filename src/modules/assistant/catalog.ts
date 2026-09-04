import "server-only";
/**
 * Каталог магазина для ассистента: что можно посоветовать клиенту и по какой ссылке это купить.
 *
 * Без каталога вопрос «посоветуйте белые гортензии» модель отвечать не может — а спрашивают об
 * этом часто, особенно с номеров без заказа. Отдаём названия, цены и публичные ссылки витрины:
 * этого хватает и на совет, и на то, чтобы человек сразу перешёл и купил.
 *
 * Берём только живые товары. Удалённый или скрытый товар в совете — это ссылка в никуда.
 */
import type { PrismaClient } from "@/generated/prisma/client";

export type CatalogItem = { name: string; price: string | null; url: string | null };

/** Сколько товаров максимум уходит в запрос: каталог целиком раздувает каждый вопрос. */
export const CATALOG_LIMIT = 60;

function priceLabel(min: unknown, max: unknown): string | null {
  const lo = min == null ? null : Number(min);
  const hi = max == null ? null : Number(max);
  if (lo == null && hi == null) return null;
  if (lo != null && hi != null && lo !== hi) return `$${lo.toFixed(0)}–$${hi.toFixed(0)}`;
  const one = lo ?? hi!;
  return `$${one.toFixed(0)}`;
}

export async function loadCatalog(prisma: PrismaClient, siteId: string, limit = CATALOG_LIMIT): Promise<CatalogItem[]> {
  const rows = await prisma.product.findMany({
    where: { siteId, status: "ACTIVE", deletedAt: null, remoteDeleted: false },
    select: { name: true, minPrice: true, maxPrice: true, onlineUrl: true },
    orderBy: { name: "asc" },
    take: limit,
  });
  return rows.map((r) => ({ name: r.name, price: priceLabel(r.minPrice, r.maxPrice), url: r.onlineUrl }));
}

/**
 * Похоже ли сообщение на разговор о покупке. Каталог нужен не всегда: «во сколько привезут» он
 * только раздувает запрос, а вот «что посоветуете на день рождения» без него не ответить.
 */
const SHOPPING_WORDS = [
  "recommend", "suggest", "advice", "advise", "looking for", "do you have", "can i get", "can i order",
  "want to order", "would like to order", "how much", "price", "cost", "cheaper", "budget",
  "bouquet", "flowers for", "arrangement", "vase", "basket", "gift",
  "rose", "hydrangea", "peony", "peonies", "tulip", "orchid", "lily", "lilies", "sunflower",
  "carnation", "ranunculus", "eucalyptus", "white flowers", "red flowers", "pink flowers",
  "birthday", "anniversary", "funeral", "wedding", "apology", "get well",
];

export function looksLikeShopping(raw: string): boolean {
  const text = raw.toLowerCase();
  return SHOPPING_WORDS.some((w) => text.includes(w));
}
