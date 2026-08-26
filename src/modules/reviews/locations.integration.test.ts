/**
 * Справочник точек Google. Требует живой БД в DATABASE_URL.
 *
 * Проверяется то, что нельзя проверить чистой функцией: правила целостности держатся на базе.
 * Две запасные точки или один ZIP у двух точек означали бы, что заказу достаётся случайная
 * ссылка — и заметить это можно было бы только по факту отправленного клиенту сообщения.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { prisma } from "@/lib/db";
import { saveGoogleLocation, parseZips, resolveLocationForZip, resolveLocationForOrder } from "./locations";

const RUN = `gloc-${Date.now()}`;
let siteId = "";
const orderIds: string[] = [];

const save = (over: Partial<Parameters<typeof saveGoogleLocation>[0]> = {}, id: string | null = null) =>
  saveGoogleLocation(
    { siteId, name: "Beverly Hills", reviewUrl: "https://g.page/r/bh/review", zips: ["90210"], isDefault: false, isActive: true, ...over },
    id
  );

async function makeOrder(zip: string) {
  const order = await prisma.order.create({
    data: {
      orderNumber: `${RUN}-${orderIds.length}`,
      siteId,
      platform: "SHOPIFY",
      source: "MANUAL",
      externalCreatedAt: new Date("2026-08-19T10:00:00Z"),
      deliveryDate: new Date("2026-08-20T00:00:00Z"),
      deliveryWindow: "12:00 – 16:00",
      senderName: "Заказчик",
      senderPhone: "+14245550000",
      recipientName: "Получатель",
      recipientPhone: "+14245551111",
      addressLine: "1 Main St",
      city: "LA",
      zip,
      itemsTotal: "100.00",
      customerTotal: "100.00",
    },
  });
  orderIds.push(order.id);
  return order.id;
}

beforeAll(async () => {
  const site = await prisma.site.create({
    data: { name: `${RUN}-site`, shortName: "GLC", platform: "SHOPIFY", connectionStatus: "CONNECTED" },
  });
  siteId = site.id;
});

beforeEach(async () => {
  await prisma.googleLocation.deleteMany({ where: { siteId } });
  await prisma.site.update({ where: { id: siteId }, data: { reviewUrl: null } });
});

afterAll(async () => {
  await prisma.googleLocation.deleteMany({ where: { siteId } }).catch(() => {});
  await prisma.order.deleteMany({ where: { siteId } }).catch(() => {});
  await prisma.site.delete({ where: { id: siteId } }).catch(() => {});
});

describe("разбор ZIP из формы", () => {
  it("запятые, пробелы, ZIP+4 и дубли сводятся к списку пятизначных кодов", () => {
    expect(parseZips("90210, 90211 90210; 90056-1234")).toEqual(["90210", "90211", "90056"]);
  });

  it("мусор отбрасывается, а не сохраняется как ZIP", () => {
    expect(parseZips("нет, —, 123")).toEqual([]);
  });
});

describe("целостность справочника", () => {
  it("вторая запасная точка снимает флаг с первой, а не падает", async () => {
    // Частичный уникальный индекс отверг бы вставку, и владелец увидел бы ошибку базы
    // вместо ожидаемого поведения «эта теперь запасная».
    const first = await save({ name: "Первая", isDefault: true });
    expect(first.ok).toBe(true);
    const second = await save({ name: "Вторая", zips: ["90056"], isDefault: true });
    expect(second.ok).toBe(true);

    const defaults = await prisma.googleLocation.findMany({ where: { siteId, isDefault: true }, select: { name: true } });
    expect(defaults).toEqual([{ name: "Вторая" }]);
  });

  it("один ZIP нельзя закрепить за двумя точками магазина", async () => {
    await save({ name: "Первая", zips: ["90210"] });
    const res = await save({ name: "Вторая", zips: ["90210", "90048"] });

    expect(res).toMatchObject({ ok: false });
    if (!res.ok) expect(res.error).toContain("90210");
    expect(await prisma.googleLocation.count({ where: { siteId } })).toBe(1);
  });

  it("своя же точка не считается конфликтом при правке", async () => {
    const created = await save({ name: "Первая", zips: ["90210"] });
    if (!created.ok) throw new Error("не создалась");
    const res = await save({ name: "Первая", zips: ["90210", "90211"] }, created.id);

    expect(res).toMatchObject({ ok: true });
    const row = await prisma.googleLocation.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.zips).toEqual(["90210", "90211"]);
  });

  it("ссылка без протокола не сохраняется", async () => {
    // Такую ссылку клиент получил бы битой, и понять это можно было бы только от него.
    expect(await save({ reviewUrl: "g.page/r/bh" })).toMatchObject({ ok: false });
    expect(await save({ name: "  " })).toMatchObject({ ok: false });
  });
});

describe("какая точка достанется адресу", () => {
  it("ZIP заказа находит свою точку", async () => {
    await save({ name: "Beverly", zips: ["90210"] });
    await save({ name: "Ladera", zips: ["90056"], isDefault: true });

    const id = await makeOrder("90056");
    const resolved = await resolveLocationForOrder(prisma, id);
    expect(resolved?.locationName).toBe("Ladera");
    expect(resolved?.result.ok && resolved.result.reason).toBe("zip");
  });

  it("ZIP+4 в заказе находит точку, размеченную пятизначным кодом", async () => {
    await save({ name: "Beverly", zips: ["90210"] });
    const id = await makeOrder("90210-4021");
    expect((await resolveLocationForOrder(prisma, id))?.locationName).toBe("Beverly");
  });

  it("незнакомый ZIP уходит на запасную точку", async () => {
    await save({ name: "Beverly", zips: ["90210"] });
    await save({ name: "Запасная", zips: [], isDefault: true });

    const id = await makeOrder("99999");
    const resolved = await resolveLocationForOrder(prisma, id);
    expect(resolved?.locationName).toBe("Запасная");
    expect(resolved?.result.ok && resolved.result.reason).toBe("default");
  });

  it("без точек работает старая ссылка магазина — живые рассылки не ломаются", async () => {
    await prisma.site.update({ where: { id: siteId }, data: { reviewUrl: "https://site/review" } });
    const id = await makeOrder("90210");
    const resolved = await resolveLocationForOrder(prisma, id);

    expect(resolved?.result.ok && resolved.result.reason).toBe("site_fallback");
    expect(resolved?.reviewUrl).toBe("https://site/review");
  });

  it("нет ни точек, ни старой ссылки — честный отказ", async () => {
    const id = await makeOrder("90210");
    expect((await resolveLocationForOrder(prisma, id))?.result).toEqual({ ok: false, error: "no_location" });
  });

  it("проверка ZIP с экрана отвечает то же, что достанется заказу", async () => {
    await save({ name: "Beverly", zips: ["90210"] });
    const byZip = await resolveLocationForZip(siteId, "90210-1111");
    const id = await makeOrder("90210-1111");
    const byOrder = await resolveLocationForOrder(prisma, id);

    expect(byZip?.locationName).toBe(byOrder?.locationName);
    expect(byZip?.reviewUrl).toBe(byOrder?.reviewUrl);
  });
});
