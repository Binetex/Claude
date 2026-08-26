/**
 * {{review_url}} в рассылках. Требует живой БД в DATABASE_URL.
 *
 * Проверяется одно: переменная берёт ТУ ЖЕ ссылку, что показывает раздел «Отзывы» — ближайшую
 * к адресу точку. Раньше она брала общую ссылку магазина, и клиент из письма уходил не туда,
 * куда его отправил бы оператор по тому же заказу.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { prisma } from "@/lib/db";
import { SMS_ORDER_INCLUDE, orderToVariableSource } from "./orderSource";
import { buildOrderVariables } from "./variables";
import { resolveLocationForOrder } from "@/modules/reviews/locations";

const RUN = `rvurl-${Date.now()}`;
let siteId = "";
const orderIds: string[] = [];

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

async function reviewUrlFor(orderId: string): Promise<string> {
  const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: SMS_ORDER_INCLUDE });
  return buildOrderVariables(orderToVariableSource(order)).review_url;
}

beforeAll(async () => {
  const site = await prisma.site.create({
    data: { name: `${RUN}-site`, shortName: "RVU", platform: "SHOPIFY", connectionStatus: "CONNECTED" },
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

describe("ссылка на отзыв в рассылке", () => {
  it("берёт ближайшую к адресу точку, а не общую ссылку магазина", async () => {
    await prisma.site.update({ where: { id: siteId }, data: { reviewUrl: "https://site/common" } });
    await prisma.googleLocation.createMany({
      data: [
        { siteId, name: "Downtown", reviewUrl: "https://g.page/r/dt/review", zipCode: "90017" },
        { siteId, name: "Mar Vista", reviewUrl: "https://g.page/r/mv/review", zipCode: "90066" },
      ],
    });

    expect(await reviewUrlFor(await makeOrder("90064"))).toBe("https://g.page/r/mv/review");
    expect(await reviewUrlFor(await makeOrder("90013"))).toBe("https://g.page/r/dt/review");
  });

  it("рассылка и карточка запроса ведут клиента в одно и то же место", async () => {
    // Второго способа получить ссылку быть не должно: иначе письмо и оператор отправляли бы
    // одного клиента в разные точки по одному заказу.
    await prisma.googleLocation.createMany({
      data: [
        { siteId, name: "Downtown", reviewUrl: "https://g.page/r/dt/review", zipCode: "90017" },
        { siteId, name: "Mar Vista", reviewUrl: "https://g.page/r/mv/review", zipCode: "90066" },
      ],
    });
    const orderId = await makeOrder("90045");

    const fromTemplate = await reviewUrlFor(orderId);
    const fromReviews = (await resolveLocationForOrder(prisma, orderId))!.reviewUrl;
    expect(fromTemplate).toBe(fromReviews);
  });

  it("точек нет — работает общая ссылка магазина, живые рассылки не ломаются", async () => {
    await prisma.site.update({ where: { id: siteId }, data: { reviewUrl: "https://site/common" } });
    expect(await reviewUrlFor(await makeOrder("90064"))).toBe("https://site/common");
  });

  it("незнакомый индекс уходит на запасную точку", async () => {
    await prisma.googleLocation.createMany({
      data: [
        { siteId, name: "Mar Vista", reviewUrl: "https://g.page/r/mv/review", zipCode: "90066" },
        { siteId, name: "Запасная", reviewUrl: "https://g.page/r/sp/review", zipCode: null, isDefault: true },
      ],
    });
    expect(await reviewUrlFor(await makeOrder("00000"))).toBe("https://g.page/r/sp/review");
  });

  it("нет ни точек, ни общей ссылки — переменная пустая, и правило не отправится", async () => {
    expect(await reviewUrlFor(await makeOrder("90064"))).toBe("");
  });
});
