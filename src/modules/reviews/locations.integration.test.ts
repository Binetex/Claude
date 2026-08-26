/**
 * Справочник точек Google. Требует живой БД в DATABASE_URL.
 *
 * Проверяется то, что нельзя проверить чистой функцией: правила целостности держатся на базе.
 * Две запасные точки или один ZIP у двух точек означали бы, что заказу достаётся случайная
 * ссылка — и заметить это можно было бы только по факту отправленного клиенту сообщения.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { prisma } from "@/lib/db";
import { saveGoogleLocation, deleteGoogleLocation, parseLocationZip, listLocationsBySite, resolveLocationForZip, resolveLocationForOrder } from "./locations";

const RUN = `gloc-${Date.now()}`;
let siteId = "";
const orderIds: string[] = [];

const save = (over: Partial<Parameters<typeof saveGoogleLocation>[0]> = {}, id: string | null = null) =>
  saveGoogleLocation(
    { siteId, name: "Beverly Hills", reviewUrl: "https://g.page/r/bh/review", zipRaw: "90210", isDefault: false, isActive: true, ...over },
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

describe("индекс точки из формы", () => {
  it("ZIP+4 и пробелы приводятся к пяти цифрам", () => {
    expect(parseLocationZip(" 90066-1234 ")).toEqual({ zip: "90066", error: null });
  });

  it("несуществующий индекс отвергается сразу", () => {
    // Без координат точка не досталась бы ни одному заказу, и владелец узнал бы об этом только
    // по молчанию, разбираясь, почему отзывы не идут.
    expect(parseLocationZip("00000").error).toContain("не найден");
    expect(parseLocationZip("9006").error).toContain("пять цифр");
  });

  it("пустое поле — это не ошибка: у запасной точки индекса может не быть", () => {
    expect(parseLocationZip("  ")).toEqual({ zip: null, error: null });
  });
});

describe("целостность справочника", () => {
  it("вторая запасная точка снимает флаг с первой, а не падает", async () => {
    // Частичный уникальный индекс отверг бы вставку, и владелец увидел бы ошибку базы
    // вместо ожидаемого поведения «эта теперь запасная».
    const first = await save({ name: "Первая", isDefault: true });
    expect(first.ok).toBe(true);
    const second = await save({ name: "Вторая", zipRaw: "90056", isDefault: true });
    expect(second.ok).toBe(true);

    const defaults = await prisma.googleLocation.findMany({ where: { siteId, isDefault: true }, select: { name: true } });
    expect(defaults).toEqual([{ name: "Вторая" }]);
  });

  it("две точки в одном индексе допустимы — адреса ни за кем не закреплены", async () => {
    // Раньше это был конфликт; теперь каждый заказ достаётся ближайшей, и запрещать нечего.
    expect(await save({ name: "Первая", zipRaw: "90210" })).toMatchObject({ ok: true });
    expect(await save({ name: "Вторая", zipRaw: "90210" })).toMatchObject({ ok: true });
  });

  it("точка без индекса не сохраняется, если она не запасная", async () => {
    // Без координат она не досталась бы ни одному заказу, но в списке выглядела бы рабочей.
    const res = await save({ name: "Без индекса", zipRaw: "" });
    expect(res).toMatchObject({ ok: false });
    if (!res.ok) expect(res.error).toContain("индекс");
  });

  it("а запасной точке индекс не нужен — она достаётся не по географии", async () => {
    expect(await save({ name: "Запасная", zipRaw: "", isDefault: true })).toMatchObject({ ok: true });
  });

  it("нерабочий индекс виден в списке точек", async () => {
    // Данные могли прийти мимо формы (перенос из прежней модели), а молчащая точка обязана
    // выглядеть сломанной.
    const created = await save({ name: "Живая", zipRaw: "90066" });
    if (!created.ok) throw new Error("не создалась");
    await prisma.googleLocation.update({ where: { id: created.id }, data: { zipCode: "00000" } });

    const blocks = await listLocationsBySite();
    const row = blocks.flatMap((b) => b.locations).find((l) => l.id === created.id)!;
    expect(row.zipKnown).toBe(false);
  });

  it("несуществующий индекс не сохраняется", async () => {
    const res = await save({ zipRaw: "00000" });
    expect(res).toMatchObject({ ok: false });
    expect(await prisma.googleLocation.count({ where: { siteId } })).toBe(0);
  });

  it("правка исчезнувшей точки даёт понятный ответ, а не падение", async () => {
    // Две вкладки: в одной точку удалили, в другой жмут «Сохранить». Раньше ошибка Prisma
    // всплывала мимо возвращаемого значения, и форма молча зависала.
    const created = await save({ name: "Временная" });
    if (!created.ok) throw new Error("не создалась");
    await prisma.googleLocation.delete({ where: { id: created.id } });

    const res = await save({ name: "Временная" }, created.id);
    expect(res).toMatchObject({ ok: false });
    if (!res.ok) expect(res.error).toContain("удалена");
  });

  it("ссылка без протокола не сохраняется", async () => {
    // Такую ссылку клиент получил бы битой, и понять это можно было бы только от него.
    expect(await save({ reviewUrl: "g.page/r/bh" })).toMatchObject({ ok: false });
    // http тоже отклоняем: сообщение обещает https, и такая ссылка открылась бы у части
    // клиентов предупреждением о небезопасном соединении вместо формы отзыва.
    expect(await save({ reviewUrl: "http://g.page/r/bh" })).toMatchObject({ ok: false });
    expect(await save({ name: "  " })).toMatchObject({ ok: false });
  });
});

describe("удаление", () => {
  it("удаление несуществующей точки честно сообщает об этом", async () => {
    // Прежняя версия глотала любую ошибку и всегда возвращала успех: форма закрывалась,
    // владелец считал точку удалённой, а она оставалась на месте.
    const res = await deleteGoogleLocation("does-not-exist");
    expect(res).toMatchObject({ ok: false });
  });

  it("существующая точка удаляется", async () => {
    const created = await save({ name: "На удаление" });
    if (!created.ok) throw new Error("не создалась");
    expect(await deleteGoogleLocation(created.id)).toMatchObject({ ok: true });
    expect(await prisma.googleLocation.count({ where: { id: created.id } })).toBe(0);
  });
});

describe("какая точка достанется адресу", () => {
  it("заказ уходит к ближайшей точке", async () => {
    await save({ name: "Downtown", zipRaw: "90017" });
    await save({ name: "Mar Vista", zipRaw: "90066" });

    const id = await makeOrder("90064"); // Palms — рядом с Mar Vista
    const resolved = await resolveLocationForOrder(prisma, id);
    expect(resolved?.locationName).toBe("Mar Vista");
    expect(resolved?.result.ok && resolved.result.reason).toBe("nearest");
    expect(resolved?.distanceMiles).toBeLessThan(5);
  });

  it("ZIP+4 в заказе тоже находит ближайшую", async () => {
    await save({ name: "Beverly", zipRaw: "90210" });
    const id = await makeOrder("90210-4021");
    expect((await resolveLocationForOrder(prisma, id))?.locationName).toBe("Beverly");
  });

  it("незнакомый индекс уходит на запасную точку", async () => {
    await save({ name: "Beverly", zipRaw: "90210" });
    await save({ name: "Запасная", zipRaw: "", isDefault: true });

    const id = await makeOrder("00000");
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

  it("проверка индекса с экрана отвечает то же, что достанется заказу", async () => {
    await save({ name: "Downtown", zipRaw: "90017" });
    await save({ name: "Mar Vista", zipRaw: "90066" });

    const byZip = await resolveLocationForZip(siteId, "90064-1111");
    const id = await makeOrder("90064-1111");
    const byOrder = await resolveLocationForOrder(prisma, id);

    expect(byZip?.locationName).toBe(byOrder?.locationName);
    expect(byZip?.reviewUrl).toBe(byOrder?.reviewUrl);
  });
});
