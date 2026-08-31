/**
 * Выборка заказов на реальной БД (throwaway prisma dev): поиск и фильтр по датам.
 * Именно то, что нельзя проверить чистыми тестами — where собирается Prisma и исполняется SQL.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { listForOwner, listForCallCenter, listForFlorist, countForFlorist, countOrders } from "./queries";

const suffix = `q-${Date.now()}`;
let siteId = "";
const orderIds: string[] = [];

/** deliveryDate хранится как UTC-полночь локального дня доставки — так и создаём. */
const day = (ymd: string) => new Date(`${ymd}T00:00:00.000Z`);

async function makeOrder(orderNumber: string, deliveryYmd: string, over: Partial<Prisma.OrderUncheckedCreateInput> = {}) {
  const o = await prisma.order.create({
    data: {
      orderNumber, siteId, platform: "WOOCOMMERCE", source: "Woo",
      externalId: `${orderIds.length}${Date.now() % 100000}`,
      externalCreatedAt: new Date(), deliveryDate: day(deliveryYmd), deliveryWindow: "12:00 - 16:00",
      senderName: "Иван Отправитель", senderPhone: "+13105550001",
      recipientName: "Мария Получатель", recipientPhone: "+13105550002",
      addressLine: "1234 Sunset Blvd", city: "Los Angeles", zip: "90026",
      itemsTotal: new Prisma.Decimal(10), customerTotal: new Prisma.Decimal(10),
      paymentStatus: "PAID", orderStatus: "FLORIST_ACCEPTED",
      ...over,
    },
  });
  orderIds.push(o.id);
  return o;
}

beforeAll(async () => {
  const site = await prisma.site.create({
    data: { name: `Q ${suffix}`, shortName: `Q${Date.now() % 1000}`, platform: "WOOCOMMERCE" },
  });
  siteId = site.id;
  await makeOrder(`THEFLOW-20211-${suffix}`, "2026-07-20");
  await makeOrder(`THEFLOW-20212-${suffix}`, "2026-07-22");
  await makeOrder(`THEFLOW-20213-${suffix}`, "2026-07-24");
});

afterAll(async () => {
  await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  await prisma.site.deleteMany({ where: { id: siteId } });
  await prisma.$disconnect();
});

/** Только заказы этого теста — в БД могут быть чужие. */
const mine = <T extends { orderNumber: string }>(rows: T[]) => rows.filter((r) => r.orderNumber.endsWith(suffix));

describe("поиск по номеру заказа", () => {
  it("номер с решёткой, как он показан в списке, находит заказ", async () => {
    const found = mine(await listForOwner({ siteId, search: "#20211" }));
    expect(found).toHaveLength(1);
    expect(found[0].orderNumber).toContain("20211");
  });

  it("тот же номер без решётки работает по-прежнему", async () => {
    expect(mine(await listForOwner({ siteId, search: "20211" }))).toHaveLength(1);
  });

  it("«№» тоже отбрасывается", async () => {
    expect(mine(await listForOwner({ siteId, search: "№20211" }))).toHaveLength(1);
  });

  it("решётка не ломает поиск по другим полям", async () => {
    // Решётка отбрасывается только для номера; имя ищется по исходному тексту.
    expect(mine(await listForOwner({ siteId, search: "Мария" }))).toHaveLength(3);
    expect(mine(await listForOwner({ siteId, search: "Sunset" }))).toHaveLength(3);
  });

  it("несуществующий номер не находит ничего", async () => {
    expect(mine(await listForOwner({ siteId, search: "#99999" }))).toHaveLength(0);
  });
});

describe("фильтр по диапазону дат доставки", () => {
  it("обе границы: включительно с обоих концов", async () => {
    const found = mine(await listForOwner({ siteId, from: "2026-07-20", to: "2026-07-22" }));
    expect(found).toHaveLength(2); // 20-е и 22-е, 24-е за пределами
  });

  it("границы включаются, а не отсекаются", async () => {
    // Один день как диапазон — заказ ровно на эту дату должен найтись.
    expect(mine(await listForOwner({ siteId, from: "2026-07-24", to: "2026-07-24" }))).toHaveLength(1);
  });

  it("только «с» — всё от даты и позже", async () => {
    expect(mine(await listForOwner({ siteId, from: "2026-07-22" }))).toHaveLength(2);
  });

  it("только «по» — всё до даты включительно", async () => {
    expect(mine(await listForOwner({ siteId, to: "2026-07-22" }))).toHaveLength(2);
  });

  it("пустой диапазон возвращает пусто, а не всё подряд", async () => {
    expect(mine(await listForOwner({ siteId, from: "2026-08-01", to: "2026-08-05" }))).toHaveLength(0);
  });

  it("одиночная дата продолжает работать (старые ссылки)", async () => {
    expect(mine(await listForOwner({ siteId, date: "2026-07-20" }))).toHaveLength(1);
  });

  it("countOrders считает по тем же правилам, что и выборка", async () => {
    const filters = { siteId, from: "2026-07-20", to: "2026-07-22" };
    const rows = mine(await listForOwner(filters));
    // countOrders считает по всему сайту — сайт создан этим тестом, чужих заказов нет.
    expect(await countOrders(filters)).toBe(rows.length);
  });
});

describe("пагинация и диапазон вместе", () => {
  it("страницы не теряют и не дублируют заказы", async () => {
    const filters = { siteId, from: "2026-07-01", to: "2026-07-31" };
    const p1 = await listForOwner({ ...filters, page: 1, perPage: 2 });
    const p2 = await listForOwner({ ...filters, page: 2, perPage: 2 });
    expect(p1).toHaveLength(2);
    expect(p2).toHaveLength(1);
    const ids = [...p1, ...p2].map((o) => o.id);
    expect(new Set(ids).size).toBe(3); // без пересечений
  });
});

/**
 * «Сегодня»/«Завтра» считаются по календарному дню МАГАЗИНА (LA), а не по дню процесса.
 * Раньше здесь брался день сервера (UTC), и каждый вечер после 17:00 по Лос-Анджелесу
 * вкладка «Сегодня» показывала завтрашние заказы — при этом список закупки, который всегда
 * считал по таймзоне магазина, справедливо говорил «на сегодня закупок нет».
 */
describe("вкладки «Сегодня» и «Завтра» — по дню магазина", () => {
  const laDay = (d: Date) =>
    new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);

  it("заказ на завтрашний день магазина не попадает в «Сегодня»", async () => {
    const tomorrowLa = new Date(`${laDay(new Date(Date.now() + 86400000))}T00:00:00.000Z`);
    const o = await makeOrder(`TOMORROW-${suffix}`, laDay(new Date(Date.now() + 86400000)));
    expect(o.deliveryDate.getTime()).toBe(tomorrowLa.getTime());

    const today = mine(await listForOwner({ siteId, preset: "today" }));
    expect(today.map((x) => x.orderNumber)).not.toContain(o.orderNumber);

    const tomorrow = mine(await listForOwner({ siteId, preset: "tomorrow" }));
    expect(tomorrow.map((x) => x.orderNumber)).toContain(o.orderNumber);
  });

  it("заказ на сегодняшний день магазина виден в «Сегодня» и не виден в «Завтра»", async () => {
    const o = await makeOrder(`TODAY-${suffix}`, laDay(new Date()));

    const today = mine(await listForOwner({ siteId, preset: "today" }));
    expect(today.map((x) => x.orderNumber)).toContain(o.orderNumber);

    const tomorrow = mine(await listForOwner({ siteId, preset: "tomorrow" }));
    expect(tomorrow.map((x) => x.orderNumber)).not.toContain(o.orderNumber);
  });

  it("заказ на вчерашний день магазина виден в «Вчера» и не виден в «Сегодня»", async () => {
    const yesterdayLa = laDay(new Date(Date.now() - 86400000));
    const o = await makeOrder(`YESTERDAY-${suffix}`, yesterdayLa);
    expect(o.deliveryDate.getTime()).toBe(new Date(`${yesterdayLa}T00:00:00.000Z`).getTime());

    const yesterday = mine(await listForOwner({ siteId, preset: "yesterday" }));
    expect(yesterday.map((x) => x.orderNumber)).toContain(o.orderNumber);

    const today = mine(await listForOwner({ siteId, preset: "today" }));
    expect(today.map((x) => x.orderNumber)).not.toContain(o.orderNumber);
  });

  it("«Вчера» берёт ровно один день магазина, а не всё прошлое", async () => {
    const yesterdayLa = laDay(new Date(Date.now() - 86400000));
    await makeOrder(`OLD-${suffix}`, laDay(new Date(Date.now() - 5 * 86400000)));

    const rows = mine(await listForOwner({ siteId, preset: "yesterday" }));
    for (const r of rows) {
      expect(new Date(r.deliveryDate).toISOString().slice(0, 10)).toBe(yesterdayLa);
    }
  });

  it("вкладка и список закупки сходятся в определении «сегодня»", async () => {
    // Обе стороны должны считать один и тот же календарный день магазина.
    const todayLa = laDay(new Date());
    const rows = mine(await listForOwner({ siteId, preset: "today" }));
    for (const r of rows) {
      expect(new Date(r.deliveryDate).toISOString().slice(0, 10)).toBe(todayLa);
    }
  });
});

/**
 * Списки колл-центра и флориста ходят тем же include, что и владельческий, — если лёгкий
 * include списков разойдётся со схемой, чистые тесты сериализаторов этого не заметят,
 * а реальный SQL упадёт здесь.
 */
describe("списки колл-центра и флориста на живой БД", () => {
  it("колл-центр видит заказы сайта: без цен, но с составом", async () => {
    const rows = mine(await listForCallCenter({ siteId, search: "#20211" }));
    expect(rows).toHaveLength(1);
    expect(rows[0]).not.toHaveProperty("finance");
    expect(rows[0]).not.toHaveProperty("customerTotal");
  });

  it("флорист видит только заказы, где он текущий исполнитель", async () => {
    const user = await prisma.user.create({
      data: { name: `Флорист ${suffix}`, email: `florist-${suffix}@test.local`, role: "FLORIST", passwordHash: "x" },
    });
    const florist = await prisma.florist.create({ data: { userId: user.id } });
    try {
      const my = await makeOrder(`FLW-${suffix}`, "2026-07-26", { currentFloristId: florist.id });

      const rows = mine(await listForFlorist(florist.id, { siteId }));
      expect(rows.map((r) => r.id)).toEqual([my.id]);
      // MAKER_ONLY по умолчанию: суммы заказчика в строке быть не должно.
      expect(rows[0].financeVisibility).toBe("MAKER_ONLY");
      expect(rows[0]).not.toHaveProperty("finance");
      expect(await countForFlorist(florist.id, { siteId })).toBe(1);
    } finally {
      await prisma.florist.delete({ where: { id: florist.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  });
});
