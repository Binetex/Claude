/**
 * Полное удаление магазина. Требует живой БД в DATABASE_URL (см. floremart integration tests).
 *
 * Проверяется главное: заказ защищает магазин от удаления, а незавершённое подключение
 * уходит целиком и не оставляет за собой ни настроек, ни служебных записей — иначе домен
 * нельзя будет подключить заново (на (platform, normalizedShopDomain) стоит @@unique).
 */
import { describe, it, expect, afterAll } from "vitest";
import { prisma } from "@/lib/db";
import { getSiteDeletionImpact, deleteSiteCompletely, SiteDeletionError } from "./deletion";

const RUN = `del-${Date.now()}`;
const created: string[] = [];

async function makeSite(suffix: string, domain: string) {
  const site = await prisma.site.create({
    data: {
      name: `${RUN}-${suffix}`,
      shortName: suffix.toUpperCase().slice(0, 8),
      platform: "SHOPIFY",
      connectionStatus: "PENDING",
      normalizedShopDomain: domain,
    },
  });
  created.push(site.id);
  return site;
}

afterAll(async () => {
  for (const id of created) {
    await prisma.order.deleteMany({ where: { siteId: id } }).catch(() => {});
    await prisma.vasePurchaseCost.deleteMany({ where: { product: { siteId: id } } }).catch(() => {});
    await prisma.siteAcquiringFeeModel.deleteMany({ where: { siteId: id } }).catch(() => {});
    await prisma.consumablesRate.deleteMany({ where: { siteId: id } }).catch(() => {});
    await prisma.site.delete({ where: { id } }).catch(() => {});
  }
});

describe("отчёт о последствиях", () => {
  it("у пустого незавершённого подключения удалять нечего, но удалить можно", async () => {
    const site = await makeSite("clean", `${RUN}-clean.myshopify.com`);
    const impact = await getSiteDeletionImpact(site.id);

    expect(impact).not.toBeNull();
    expect(impact!.canDelete).toBe(true);
    expect(impact!.blockers).toEqual([]);
    expect(impact!.orders).toBe(0);
    expect(impact!.willDelete).toEqual([]);
    // Ни токена, ни client id — подключение так и не довели до конца.
    expect(impact!.neverConnected).toBe(true);
  });

  it("считает связанные записи, а не просто «есть/нет»", async () => {
    const site = await makeSite("counts", `${RUN}-counts.myshopify.com`);
    await prisma.siteSync.create({ data: { siteId: site.id, kind: "PRODUCTS", status: "DONE" } });
    await prisma.consumablesRate.create({
      data: { siteId: site.id, amountCents: 150, createdBy: "test" },
    });

    const impact = await getSiteDeletionImpact(site.id);
    const labels = Object.fromEntries(impact!.willDelete.map((r) => [r.label, r.count]));

    expect(labels["Записи синхронизации"]).toBe(1);
    expect(labels["Ставки расходников"]).toBe(1);
    // Нулевые строки в отчёт не попадают — они бы только зашумляли список.
    expect(impact!.willDelete.every((r) => r.count > 0)).toBe(true);
  });

  it("несуществующий магазин — null, а не исключение", async () => {
    expect(await getSiteDeletionImpact("нет-такого-id")).toBeNull();
  });
});

describe("защита заказами", () => {
  it("магазин с заказом не удаляется и объясняет почему", async () => {
    const site = await makeSite("orders", `${RUN}-orders.myshopify.com`);
    await prisma.order.create({
      data: {
        orderNumber: `${RUN}-1`,
        siteId: site.id,
        source: "test",
        platform: "SHOPIFY",
        externalCreatedAt: new Date(),
        deliveryDate: new Date("2026-08-10T00:00:00.000Z"),
        deliveryWindow: "10-14",
        senderName: "S",
        senderPhone: "1",
        recipientName: "R",
        recipientPhone: "2",
        addressLine: "a",
        city: "c",
        zip: "z",
        itemsTotal: 10,
        customerTotal: 10,
        updatedAt: new Date(),
      },
    });

    const impact = await getSiteDeletionImpact(site.id);
    expect(impact!.canDelete).toBe(false);
    expect(impact!.orders).toBe(1);
    expect(impact!.blockers[0]).toContain("заказов: 1");

    await expect(deleteSiteCompletely(site.id)).rejects.toThrow(SiteDeletionError);
    // Магазин на месте — отказ не должен ничего повредить.
    expect(await prisma.site.count({ where: { id: site.id } })).toBe(1);
  });

  it("проверка заказов делается на свежих данных, а не по отчёту", async () => {
    const site = await makeSite("race", `${RUN}-race.myshopify.com`);
    // Отчёт снят, когда заказов ещё не было.
    const impact = await getSiteDeletionImpact(site.id);
    expect(impact!.canDelete).toBe(true);

    // …а заказ появился уже после того, как экран открыли.
    await prisma.order.create({
      data: {
        orderNumber: `${RUN}-race-1`,
        siteId: site.id,
        source: "test",
        platform: "SHOPIFY",
        externalCreatedAt: new Date(),
        deliveryDate: new Date("2026-08-10T00:00:00.000Z"),
        deliveryWindow: "10-14",
        senderName: "S",
        senderPhone: "1",
        recipientName: "R",
        recipientPhone: "2",
        addressLine: "a",
        city: "c",
        zip: "z",
        itemsTotal: 10,
        customerTotal: 10,
        updatedAt: new Date(),
      },
    });

    await expect(deleteSiteCompletely(site.id)).rejects.toThrow(/заказов/);
  });
});

describe("полное удаление", () => {
  it("уносит и каскадные связи, и те, что защищены Restrict", async () => {
    const site = await makeSite("full", `${RUN}-full.myshopify.com`);

    // Каскадные.
    await prisma.siteSync.create({ data: { siteId: site.id, kind: "ORDERS", status: "DONE" } });
    const product = await prisma.product.create({
      data: { siteId: site.id, externalId: `${RUN}-p1`, name: "Букет", status: "ACTIVE" },
    });
    // Restrict — каскад их не заберёт, модуль обязан удалить руками.
    await prisma.consumablesRate.create({
      data: { siteId: site.id, amountCents: 100, createdBy: "test" },
    });
    await prisma.vasePurchaseCost.create({
      data: { productId: product.id, costType: "STANDALONE_VASE", purchaseCostCents: 500, createdBy: "test" },
    });

    const res = await deleteSiteCompletely(site.id);
    expect(res.domain).toBe(`${RUN}-full.myshopify.com`);

    expect(await prisma.site.count({ where: { id: site.id } })).toBe(0);
    expect(await prisma.siteSync.count({ where: { siteId: site.id } })).toBe(0);
    expect(await prisma.product.count({ where: { siteId: site.id } })).toBe(0);
    expect(await prisma.consumablesRate.count({ where: { siteId: site.id } })).toBe(0);
    expect(await prisma.vasePurchaseCost.count({ where: { id: { not: "" }, productId: product.id } })).toBe(0);
  });

  it("после удаления тот же домен подключается заново", async () => {
    const domain = `${RUN}-reuse.myshopify.com`;
    const first = await makeSite("reuse", domain);
    await deleteSiteCompletely(first.id);

    // На (platform, normalizedShopDomain) стоит @@unique: если бы от старого магазина
    // осталась строка, повторное подключение упало бы на уникальном индексе.
    const second = await makeSite("reuse2", domain);
    expect(second.id).not.toBe(first.id);
    expect(second.normalizedShopDomain).toBe(domain);
  });

  it("удалять несуществующий магазин — понятная ошибка, а не падение", async () => {
    await expect(deleteSiteCompletely("нет-такого-id")).rejects.toThrow(SiteDeletionError);
  });
});
