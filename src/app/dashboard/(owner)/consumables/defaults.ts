import "server-only";
/**
 * Стартовый набор справочника — ровно колонки таблицы, которую владелец вёл в Google Sheets.
 *
 * Создаётся один раз по кнопке, а не миграцией: брендированные позиции нужно привязать к
 * конкретному магазину, а его id в каждой установке свой.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { vaseTypeOf } from "@/modules/consumables/rules";

export type DefaultItem = { name: string; autoRule?: string; autoKey?: string; branded?: boolean; sortOrder: number };

export const DEFAULT_ITEMS: DefaultItem[] = [
  // Коробки и конверты — только руками (правило их не выводит).
  { name: "Small Box THEFLOW", branded: true, sortOrder: 10 },
  { name: "Small Box", sortOrder: 20 },
  { name: "Large Box", sortOrder: 30 },
  { name: "Envelope", sortOrder: 50 },
  { name: "Envelope THEFLOW", branded: true, autoRule: "BRANDED_ENVELOPE", sortOrder: 60 },

  // Считаются правилом.
  { name: "Донышки", autoRule: "VASE_BOTTOM", sortOrder: 40 },
  { name: "Bouquet care guide", branded: true, autoRule: "CARE_GUIDE_BOUQUET", sortOrder: 70 },
  { name: "Vase care guide", branded: true, autoRule: "CARE_GUIDE_VASE", sortOrder: 80 },

  { name: "Bud Vase", autoRule: "VASE_TYPE", autoKey: "BUD", sortOrder: 100 },
  { name: "Sage Vase", autoRule: "VASE_TYPE", autoKey: "SAGE", sortOrder: 110 },
  { name: "White Matte Vase", autoRule: "VASE_TYPE", autoKey: "WHITE_MATTE", sortOrder: 120 },
  { name: "Chocolate Vase", autoRule: "VASE_TYPE", autoKey: "CHOCOLATE", sortOrder: 130 },
  { name: "Clear Glass Vase", autoRule: "VASE_TYPE", autoKey: "CLEAR_GLASS", sortOrder: 140 },
  { name: "Large Glass Vase", autoRule: "VASE_TYPE", autoKey: "LARGE_GLASS", sortOrder: 150 },
  // Эти типы встречаются в заказах, но в таблице владельца колонок под них не было.
  { name: "Beige Vase", autoRule: "VASE_TYPE", autoKey: "BEIGE", sortOrder: 160 },
  { name: "Contour Rib Vase", autoRule: "VASE_TYPE", autoKey: "CONTOUR_RIB", sortOrder: 170 },
  { name: "Textured Vase", autoRule: "VASE_TYPE", autoKey: "TEXTURED", sortOrder: 180 },
];

export async function createDefaultItems(prisma: PrismaClient, brandedSiteId: string | null): Promise<number> {
  const existing = await prisma.consumableItem.count();
  if (existing > 0) return 0; // повторное нажатие ничего не дублирует

  const photoByVase = await vasePhotos(prisma);

  await prisma.consumableItem.createMany({
    data: DEFAULT_ITEMS.map((d) => ({
      name: d.name,
      siteId: d.branded ? brandedSiteId : null,
      autoRule: d.autoRule ?? null,
      autoKey: d.autoKey ?? null,
      imageUrl: d.autoKey ? photoByVase.get(d.autoKey) ?? null : null,
      sortOrder: d.sortOrder,
    })),
  });
  return DEFAULT_ITEMS.length;
}

/**
 * Фотографии ваз из каталога товаров: колонку с картинкой видно глазами, а не читаешь название.
 *
 * Берём только «чистые» вазы — товары, чьё НАЗВАНИЕ само по себе распознаётся как тип вазы.
 * Букеты вида «Apricot & Vase - Clear Glass Vase» сюда не годятся: на фото там букет, а не ваза.
 */
async function vasePhotos(prisma: PrismaClient): Promise<Map<string, string>> {
  const products = await prisma.product.findMany({
    where: { name: { contains: "Vase", mode: "insensitive" }, image: { not: null } },
    select: { name: true, image: true },
    orderBy: { name: "asc" },
  });

  const out = new Map<string, string>();
  for (const p of products) {
    // «& Vase» — это букет в комплекте с вазой, у него на фото букет.
    if (/&\s*vase/i.test(p.name)) continue;
    const key = vaseTypeOf({ name: p.name, variantName: null, quantity: 1 });
    if (key && p.image && !out.has(key)) out.set(key, p.image);
  }
  return out;
}
