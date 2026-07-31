/**
 * Stage 0 на реальной БД (throwaway prisma dev): lifecycle-триггеры заказа публикуются ровно
 * один раз и ровно на переходе.
 *
 * Проверяем три вещи, которые чистой функцией не проверить:
 *  1) проводку в WooCommerce-ingest — что «живой» webhook публикует, а bulk-sync/backfill нет;
 *  2) отсутствие дублей в outbox при повторных webhook'ах;
 *  3) дедуп ORDER_DELIVERED между ДВУМЯ источниками (курьер Burq и платформа), у которых
 *     разные occurrenceKey и обычного дедупа по ключу недостаточно.
 *
 * Запуск: DATABASE_URL=<local> NODE_OPTIONS=--conditions=react-server npx vitest run <this>
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import { prisma } from "@/lib/db";
import { ingestWooOrder, type WooIngestConfig } from "@/integrations/woocommerce/ingestWooOrder";
import { AUTOMATION_TRIGGER_EVENT } from "./events";
import { publishOrderDeliveredTrigger, publishPlatformOrderDeliveredTrigger } from "./lifecycle";

const SHORT = `LT${crypto.randomBytes(4).toString("hex")}`.slice(0, 12);
let siteId = "";

const ingestConfig: WooIngestConfig = {
  payment: {
    airwallexEnabled: false,
    klarnaPayLaterPendingIsConfirmed: false,
    airwallexPaymentMethodIds: [],
    airwallexMetaKeys: null,
    payLaterMaxWaitMinutes: 1440,
    unknownBehavior: "HOLD",
  },
  orderMetaMapping: null,
};

/** Заказ Woo. `at` — date_modified_gmt: у ingest есть out-of-order guard, время должно расти. */
const wooOrder = (id: number, status: string, at: string) => ({
  id,
  number: String(id),
  status,
  date_created_gmt: "2026-08-01T10:00:00",
  date_modified_gmt: at,
  billing: { first_name: "John", last_name: "Buyer", phone: "+15551112222", email: "j@x.com" },
  shipping: { first_name: "Ann", last_name: "Recip", phone: "+15553334444", address_1: "1 St", city: "Town", postcode: "1000" },
  line_items: [{ id: 1, name: "Rose", product_id: 100, quantity: 1, price: "100" }],
  total: "100", total_tax: "0", shipping_total: "0", discount_total: "0",
});

const site = () => ({ id: siteId, shortName: SHORT });
const live = { emitLifecycle: true }; // «живой» webhook

async function orderIdOf(externalId: string): Promise<string> {
  const o = await prisma.order.findFirst({ where: { siteId, externalId }, select: { id: true } });
  return o!.id;
}

/** Сколько trigger-событий данного типа лежит в outbox по этому заказу. */
async function triggerCount(orderId: string, triggerType: string): Promise<number> {
  const rows = await prisma.outboxEvent.findMany({
    where: { eventType: AUTOMATION_TRIGGER_EVENT, aggregateType: "order", aggregateId: orderId },
    select: { payload: true },
  });
  return rows.filter((r) => (r.payload as { triggerType?: string })?.triggerType === triggerType).length;
}

beforeAll(async () => {
  const s = await prisma.site.create({
    data: { name: `Lifecycle Test ${SHORT}`, shortName: SHORT, platform: "WOOCOMMERCE" },
    select: { id: true },
  });
  siteId = s.id;
});

afterAll(async () => {
  const orders = await prisma.order.findMany({ where: { siteId }, select: { id: true } });
  const ids = orders.map((o) => o.id);
  await prisma.outboxEvent.deleteMany({ where: { aggregateId: { in: [...ids, siteId] } } });
  await prisma.delivery.deleteMany({ where: { orderId: { in: ids } } });
  await prisma.order.deleteMany({ where: { siteId } });
  await prisma.site.deleteMany({ where: { id: siteId } });
});

describe("ORDER_PAID", () => {
  it("неоплаченный заказ при создании триггера не даёт; оплата даёт ровно один", async () => {
    await ingestWooOrder(site(), wooOrder(9001, "pending", "2026-08-01T10:00:00") as never, ingestConfig, live);
    const orderId = await orderIdOf("9001");
    expect(await triggerCount(orderId, "ORDER_PAID")).toBe(0);
    expect(await triggerCount(orderId, "ORDER_CREATED")).toBe(1);

    await ingestWooOrder(site(), wooOrder(9001, "processing", "2026-08-01T11:00:00") as never, ingestConfig, live);
    expect(await triggerCount(orderId, "ORDER_PAID")).toBe(1);

    // Повторные webhook'ы того же состояния — без дублей.
    await ingestWooOrder(site(), wooOrder(9001, "processing", "2026-08-01T12:00:00") as never, ingestConfig, live);
    await ingestWooOrder(site(), wooOrder(9001, "processing", "2026-08-01T13:00:00") as never, ingestConfig, live);
    expect(await triggerCount(orderId, "ORDER_PAID")).toBe(1);
  });

  it("заказ, пришедший уже оплаченным, публикует ORDER_PAID при создании", async () => {
    await ingestWooOrder(site(), wooOrder(9002, "processing", "2026-08-01T10:00:00") as never, ingestConfig, live);
    const orderId = await orderIdOf("9002");
    expect(await triggerCount(orderId, "ORDER_PAID")).toBe(1);
  });
});

describe("ORDER_DELIVERED", () => {
  it("переход в completed публикует ровно один триггер, повторы — без дублей", async () => {
    await ingestWooOrder(site(), wooOrder(9003, "processing", "2026-08-01T10:00:00") as never, ingestConfig, live);
    const orderId = await orderIdOf("9003");
    expect(await triggerCount(orderId, "ORDER_DELIVERED")).toBe(0);

    await ingestWooOrder(site(), wooOrder(9003, "completed", "2026-08-01T11:00:00") as never, ingestConfig, live);
    expect(await triggerCount(orderId, "ORDER_DELIVERED")).toBe(1);

    await ingestWooOrder(site(), wooOrder(9003, "completed", "2026-08-01T12:00:00") as never, ingestConfig, live);
    expect(await triggerCount(orderId, "ORDER_DELIVERED")).toBe(1);
  });

  it("курьер и платформа не дают двух «доставлено» (разные occurrenceKey)", async () => {
    await ingestWooOrder(site(), wooOrder(9004, "processing", "2026-08-01T10:00:00") as never, ingestConfig, live);
    const orderId = await orderIdOf("9004");
    const delivery = await prisma.delivery.create({ data: { orderId }, select: { id: true } });

    // Сначала подтверждение курьера (Burq webhook / ручное «отметить доставленным»).
    await publishOrderDeliveredTrigger(prisma, { orderId, deliveryId: delivery.id });
    expect(await triggerCount(orderId, "ORDER_DELIVERED")).toBe(1);

    // Затем магазин отмечает заказ completed — второго триггера быть не должно.
    await ingestWooOrder(site(), wooOrder(9004, "completed", "2026-08-01T11:00:00") as never, ingestConfig, live);
    expect(await triggerCount(orderId, "ORDER_DELIVERED")).toBe(1);
  });

  it("обратный порядок (платформа раньше курьера) тоже даёт один триггер", async () => {
    await ingestWooOrder(site(), wooOrder(9005, "processing", "2026-08-01T10:00:00") as never, ingestConfig, live);
    const orderId = await orderIdOf("9005");
    const delivery = await prisma.delivery.create({ data: { orderId }, select: { id: true } });

    await publishPlatformOrderDeliveredTrigger(prisma, { orderId, siteId });
    expect(await triggerCount(orderId, "ORDER_DELIVERED")).toBe(1);

    await publishOrderDeliveredTrigger(prisma, { orderId, deliveryId: delivery.id });
    expect(await triggerCount(orderId, "ORDER_DELIVERED")).toBe(1);
  });
});

describe("ORDER_CANCELLED", () => {
  it("отмена публикует ORDER_CANCELLED ровно один раз", async () => {
    await ingestWooOrder(site(), wooOrder(9006, "processing", "2026-08-01T10:00:00") as never, ingestConfig, live);
    const orderId = await orderIdOf("9006");

    await ingestWooOrder(site(), wooOrder(9006, "cancelled", "2026-08-01T11:00:00") as never, ingestConfig, live);
    expect(await triggerCount(orderId, "ORDER_CANCELLED")).toBe(1);

    await ingestWooOrder(site(), wooOrder(9006, "cancelled", "2026-08-01T12:00:00") as never, ingestConfig, live);
    expect(await triggerCount(orderId, "ORDER_CANCELLED")).toBe(1);
  });

  it("возврат даёт ORDER_REFUNDED и НЕ даёт ORDER_CANCELLED", async () => {
    await ingestWooOrder(site(), wooOrder(9007, "processing", "2026-08-01T10:00:00") as never, ingestConfig, live);
    const orderId = await orderIdOf("9007");

    await ingestWooOrder(site(), wooOrder(9007, "refunded", "2026-08-01T11:00:00") as never, ingestConfig, live);
    expect(await triggerCount(orderId, "ORDER_REFUNDED")).toBe(1);
    expect(await triggerCount(orderId, "ORDER_CANCELLED")).toBe(0);
  });
});

describe("resync / backfill", () => {
  it("без emitLifecycle не публикуется ни один триггер (bulk-sync истории)", async () => {
    await ingestWooOrder(site(), wooOrder(9008, "processing", "2026-08-01T10:00:00") as never, ingestConfig);
    const orderId = await orderIdOf("9008");
    await ingestWooOrder(site(), wooOrder(9008, "completed", "2026-08-01T11:00:00") as never, ingestConfig);
    await ingestWooOrder(site(), wooOrder(9008, "cancelled", "2026-08-01T12:00:00") as never, ingestConfig);

    for (const t of ["ORDER_CREATED", "ORDER_PAID", "ORDER_DELIVERED", "ORDER_CANCELLED"]) {
      expect(await triggerCount(orderId, t)).toBe(0);
    }
  });

  it("resync ПОСЛЕ живого перехода не публикует его повторно", async () => {
    await ingestWooOrder(site(), wooOrder(9009, "processing", "2026-08-01T10:00:00") as never, ingestConfig, live);
    const orderId = await orderIdOf("9009");
    await ingestWooOrder(site(), wooOrder(9009, "completed", "2026-08-01T11:00:00") as never, ingestConfig, live);
    expect(await triggerCount(orderId, "ORDER_DELIVERED")).toBe(1);

    // Тот же заказ приезжает bulk-синхронизацией — состояние уже применено, переходов нет.
    await ingestWooOrder(site(), wooOrder(9009, "completed", "2026-08-01T12:00:00") as never, ingestConfig);
    expect(await triggerCount(orderId, "ORDER_DELIVERED")).toBe(1);
  });
});
