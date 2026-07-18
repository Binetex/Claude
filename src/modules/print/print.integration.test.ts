/**
 * DB integration: доступ и редактирование печати открыток. Локальная тестовая БД.
 * Запуск: DATABASE_URL=<local> NODE_OPTIONS=--conditions=react-server npx vitest run <this>
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import { prisma } from "@/lib/db";
import { utcDayRangeForLocalToday } from "@/lib/tz";
import { loadPrintableCards } from "./loadPrintable";
import { floristSetCardMessage } from "./cardEdit";

const RUN = `print${crypto.randomBytes(3).toString("hex")}`;
const today = utcDayRangeForLocalToday("America/Los_Angeles").gte; // UTC-полночь сегодняшнего дня в LA
let siteId = "";
let floristA = "";
let floristB = "";
const ids: Record<string, string> = {};

async function makeFlorist(tag: string): Promise<string> {
  const u = await prisma.user.create({
    data: { name: `F-${tag}`, email: `${RUN}-${tag}@t.test`, role: "FLORIST", passwordHash: "x", florist: { create: {} } },
    select: { florist: { select: { id: true } } },
  });
  return u.florist!.id;
}

async function makeOrder(key: string, over: Record<string, unknown>): Promise<string> {
  const o = await prisma.order.create({
    data: {
      orderNumber: `${RUN}-${key}`,
      siteId,
      source: "Test",
      platform: "WOOCOMMERCE",
      externalCreatedAt: today,
      deliveryDate: today,
      deliveryWindow: "14:00–18:00",
      senderName: "Sender",
      senderPhone: "+1",
      recipientName: "Recipient",
      recipientPhone: "+2",
      addressLine: "1 St",
      city: "LA",
      zip: "90001",
      itemsTotal: "10",
      customerTotal: "10",
      cardMessage: "Hello",
      originalCardMessage: "orig",
      customerNote: "INTERNAL NOTE",
      orderStatus: "CONFIRMED",
      paymentStatus: "PAID",
      ...over,
    },
    select: { id: true },
  });
  return o.id;
}

beforeAll(async () => {
  const site = await prisma.site.create({
    data: { name: "Print Test", shortName: RUN.slice(0, 10).toUpperCase(), platform: "WOOCOMMERCE", connectionStatus: "CONNECTED", timezone: "America/Los_Angeles" },
    select: { id: true },
  });
  siteId = site.id;
  floristA = await makeFlorist("A");
  floristB = await makeFlorist("B");
  ids.o1 = await makeOrder("o1", { currentFloristId: floristA, cardMessage: "Hello A" });
  ids.o2 = await makeOrder("o2", { currentFloristId: floristA, cardMessage: "" }); // пустой текст
  ids.o3 = await makeOrder("o3", { currentFloristId: floristB, cardMessage: "Foreign B" }); // чужой
  ids.o4 = await makeOrder("o4", { currentFloristId: floristA, cardMessage: "Cancelled", orderStatus: "CANCELLED" });
  ids.o5 = await makeOrder("o5", { currentFloristId: floristA, cardMessage: "Refunded", paymentStatus: "REFUNDED" });
});

afterAll(async () => {
  await prisma.order.deleteMany({ where: { siteId } });
  await prisma.florist.deleteMany({ where: { user: { email: { startsWith: `${RUN}-` } } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: `${RUN}-` } } });
  await prisma.site.deleteMany({ where: { id: siteId } });
});

describe("loadPrintableCards — доступ (§14: 9,10,11)", () => {
  it("9) флорист видит ТОЛЬКО свои заказы", async () => {
    const cards = await loadPrintableCards({ role: "FLORIST", floristId: floristA }, { ids: [ids.o1, ids.o2, ids.o3] });
    const got = cards.map((c) => c.orderId).sort();
    expect(got).toEqual([ids.o1, ids.o2].sort()); // o3 (чужой) отсеян
  });

  it("флорист не может вытащить чужой заказ по ids", async () => {
    const cards = await loadPrintableCards({ role: "FLORIST", floristId: floristA }, { ids: [ids.o3] });
    expect(cards).toHaveLength(0);
  });

  it("10) владелец видит все заказы", async () => {
    const cards = await loadPrintableCards({ role: "OWNER" }, { ids: [ids.o1, ids.o3] });
    expect(cards.map((c) => c.orderId).sort()).toEqual([ids.o1, ids.o3].sort());
  });

  it("CALL_CENTER не имеет доступа к массовой печати", async () => {
    expect(await loadPrintableCards({ role: "CALL_CENTER" }, { ids: [ids.o1] })).toHaveLength(0);
  });

  it("todayAll: исключает пустой текст, CANCELLED и полностью REFUNDED", async () => {
    const cards = await loadPrintableCards({ role: "FLORIST", floristId: floristA }, { todayAll: true });
    expect(cards.map((c) => c.orderId)).toEqual([ids.o1]); // только o1 (o2 пустой, o4 cancelled, o5 refunded)
  });

  it("todayAll includeBlank: показывает и пустые (для списка вкладки), но не чужие/cancelled/refunded", async () => {
    const cards = await loadPrintableCards({ role: "FLORIST", floristId: floristA }, { todayAll: true, includeBlank: true });
    expect(cards.map((c) => c.orderId).sort()).toEqual([ids.o1, ids.o2].sort());
  });

  it("11) пустой cardMessage НЕ подменяется customerNote", async () => {
    const cards = await loadPrintableCards({ role: "FLORIST", floristId: floristA }, { ids: [ids.o2] });
    expect(cards[0].cardMessage).toBe(""); // именно пусто, не «INTERNAL NOTE»
    expect(cards[0].hasCardMessage).toBe(false);
    expect(JSON.stringify(cards[0])).not.toContain("INTERNAL NOTE");
  });

  it("ids: дедуп и лимит применяются (дубли не создают дублей карточек)", async () => {
    const cards = await loadPrintableCards({ role: "FLORIST", floristId: floristA }, { ids: [ids.o1, ids.o1, ids.o1] });
    expect(cards).toHaveLength(1);
  });
});

describe("floristSetCardMessage — редактирование (владение)", () => {
  it("меняет ТОЛЬКО cardMessage своего заказа; original/customerNote не трогает", async () => {
    const r = await floristSetCardMessage(ids.o1, floristA, "New card  \nsecond line");
    expect(r.ok).toBe(true);
    const o = await prisma.order.findUnique({ where: { id: ids.o1 }, select: { cardMessage: true, originalCardMessage: true, customerNote: true } });
    expect(o!.cardMessage).toBe("New card\nsecond line"); // хвостовые пробелы убраны, перенос сохранён
    expect(o!.originalCardMessage).toBe("orig"); // не изменён
    expect(o!.customerNote).toBe("INTERNAL NOTE"); // не изменён
  });

  it("чужой заказ → ok=false, текст не меняется", async () => {
    const before = await prisma.order.findUnique({ where: { id: ids.o3 }, select: { cardMessage: true } });
    const r = await floristSetCardMessage(ids.o3, floristA, "HACKED");
    expect(r.ok).toBe(false);
    const after = await prisma.order.findUnique({ where: { id: ids.o3 }, select: { cardMessage: true } });
    expect(after!.cardMessage).toBe(before!.cardMessage); // не изменён
  });
});
