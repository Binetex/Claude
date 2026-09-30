/**
 * Адрес без номера дома (30.09.2026, THEFLOW-20867). Требует живой БД в DATABASE_URL.
 *
 * Проверяется путь целиком от оплаты заказа: сигнал людям уходит ровно тогда, когда адрес
 * курьеру не отдать, заказчика просит правило — только если адрес есть, но без номера (пустой
 * может быть самовывозом), а обычный адрес не рождает ничего. Сам отказ Burq — в eligibility.test.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/lib/db";
import { publishOrderLifecycleTriggers } from "@/modules/automations/lifecycle";
import { AUTOMATION_TRIGGER_EVENT } from "@/modules/automations/events";

const RUN = `adr-${Date.now()}`;
let siteId = "";

async function makeOrder(addressLine: string) {
  const o = await prisma.order.create({
    data: {
      orderNumber: `${RUN}-${Math.random().toString(36).slice(2, 7)}`,
      siteId, platform: "WOOCOMMERCE", source: "Website", externalCreatedAt: new Date(),
      deliveryDate: new Date("2026-10-01T00:00:00Z"), deliveryWindow: "15:00 - 19:00",
      senderName: "Заказчица", senderPhone: "+14245550000", recipientName: "Получатель", recipientPhone: "+14245551111",
      addressLine, apartment: "South Montebello", city: "Rosemead", zip: "91770",
      itemsTotal: "100.00", customerTotal: "110.00", paymentStatus: "PAID", orderStatus: "CONFIRMED",
    },
    select: { id: true },
  });
  // Заказ пришёл сразу оплаченным — ровно то, что делает приём заказа с сайта.
  await publishOrderLifecycleTriggers(prisma, { orderId: o.id, siteId, prev: null, next: { orderStatus: "CONFIRMED", paymentStatus: "PAID" } });
  return o.id;
}

async function events(orderId: string) {
  const rows = await prisma.outboxEvent.findMany({ where: { aggregateId: orderId }, select: { eventType: true, payload: true } });
  return {
    telegram: rows.filter((r) => r.eventType === "telegram.notify").map((r) => (r.payload as { type: string }).type).sort(),
    triggers: rows.filter((r) => r.eventType === AUTOMATION_TRIGGER_EVENT).map((r) => (r.payload as { triggerType: string }).triggerType).sort(),
  };
}

beforeAll(async () => {
  siteId = (await prisma.site.create({ data: { name: `${RUN}-site`, shortName: "ADR", platform: "WOOCOMMERCE", connectionStatus: "CONNECTED" } })).id;
});

afterAll(async () => {
  const ids = (await prisma.order.findMany({ where: { siteId }, select: { id: true } })).map((o) => o.id);
  await prisma.outboxEvent.deleteMany({ where: { aggregateId: { in: ids } } }).catch(() => {});
  await prisma.order.deleteMany({ where: { siteId } }).catch(() => {});
  await prisma.site.delete({ where: { id: siteId } }).catch(() => {});
  await prisma.$disconnect();
});

describe("оплаченный заказ с адресом без номера дома", () => {
  it("владельцу и колл-центру — сигнал, правилам — «попросить заказчика дописать адрес»", async () => {
    const id = await makeOrder("Steddom Drive");
    expect(await events(id)).toEqual({
      telegram: ["order.address_incomplete", "order.address_incomplete_cc"],
      triggers: ["ORDER_ADDRESS_INCOMPLETE", "ORDER_PAID"],
    });
  });

  it("пустой адрес — людям сигнал, а заказчику не пишем: это может быть самовывоз", async () => {
    const id = await makeOrder("");
    expect(await events(id)).toEqual({ telegram: ["order.address_incomplete", "order.address_incomplete_cc"], triggers: ["ORDER_PAID"] });
  });

  it("обычный адрес с номером — ничего лишнего", async () => {
    const id = await makeOrder("8322 Steddom Drive");
    expect(await events(id)).toEqual({ telegram: [], triggers: ["ORDER_PAID"] });
  });
});
