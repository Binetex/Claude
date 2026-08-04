"use server";
/**
 * Серверные действия формы ручного заказа. Тонкие обёртки: вся логика — в
 * modules/orders/manualOrder, роль проверяется здесь.
 */
import { requireRole } from "@/lib/rbac";
import { prisma } from "@/lib/db";
import { toNumber } from "@/lib/money";
import { createManualOrder, ManualOrderError, type CreateManualOrderInput } from "@/modules/orders/manualOrder";

export type CatalogHit = {
  productId: string;
  variantId: string | null;
  productName: string;
  variantName: string | null;
  siteName: string;
  siteId: string;
  image: string | null;
  /** Цена сайта за штуку. */
  customerPrice: number;
  /** Цена флориста за штуку; 0 — не задана в каталоге. */
  floristPrice: number;
  composition: string | null;
};

/**
 * Поиск товара для формы заказа.
 *
 * Отдаёт ВАРИАНТЫ, а не товары: выбирать в заказ нужно конкретный вариант — от него зависят
 * и цена, и состав, и финансовый тип. У товара без вариантов отдаётся он сам.
 *
 * Архивные (remoteDeleted) не показываются: положить в новый заказ то, чего уже нет на
 * витрине, — почти всегда ошибка.
 */
export async function ownerSearchCatalog(query: string, siteId: string | null): Promise<CatalogHit[]> {
  await requireRole("OWNER");
  const q = query.trim();

  const products = await prisma.product.findMany({
    where: {
      remoteDeleted: false,
      ...(siteId ? { siteId } : {}),
      ...(q ? { name: { contains: q, mode: "insensitive" as const } } : {}),
    },
    select: {
      id: true,
      name: true,
      image: true,
      floristPrice: true,
      site: { select: { id: true, name: true } },
      variants: {
        where: { remoteDeleted: false },
        orderBy: { listPrice: "asc" },
        select: { id: true, title: true, image: true, listPrice: true, floristPrice: true, floristComposition: true },
      },
    },
    orderBy: { name: "asc" },
    // Список живёт в поповере: больше двух десятков строк там всё равно не пролистать,
    // а поиск сузит выдачу быстрее, чем прокрутка.
    take: 25,
  });

  const hits: CatalogHit[] = [];
  for (const p of products) {
    if (p.variants.length === 0) {
      hits.push({
        productId: p.id,
        variantId: null,
        productName: p.name,
        variantName: null,
        siteId: p.site.id,
        siteName: p.site.name,
        image: p.image,
        customerPrice: 0,
        floristPrice: toNumber(p.floristPrice ?? 0),
        composition: null,
      });
      continue;
    }
    for (const v of p.variants) {
      hits.push({
        productId: p.id,
        variantId: v.id,
        productName: p.name,
        variantName: v.title,
        siteId: p.site.id,
        siteName: p.site.name,
        image: v.image ?? p.image,
        customerPrice: toNumber(v.listPrice),
        floristPrice: toNumber(v.floristPrice ?? p.floristPrice ?? 0),
        composition: v.floristComposition,
      });
    }
  }
  return hits.slice(0, 40);
}

export async function ownerCreateManualOrder(
  input: CreateManualOrderInput
): Promise<{ ok?: true; orderId?: string; orderNumber?: string; error?: string }> {
  await requireRole("OWNER");
  try {
    const res = await createManualOrder(input);
    return { ok: true, ...res };
  } catch (e) {
    if (e instanceof ManualOrderError) return { error: e.message };
    throw e;
  }
}
