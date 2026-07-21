import { describe, it, expect } from "vitest";
import { Prisma } from "@/generated/prisma/client";
import {
  serializeForOwner,
  serializeForCallCenter,
  serializeForFlorist,
  type OrderWithRelations,
} from "./serialize";

/**
 * Гварды ролевой видимости — самый чувствительный инвариант проекта (см. CLAUDE.md):
 *  - колл-центр НИКОГДА не видит финансы/цены;
 *  - флорист видит ТОЛЬКО свою цену; никогда — прибыль владельца, себестоимость доставки,
 *    цену клиента по позициям, чужие цены;
 *  - владелец видит всё.
 * Тест на чистых объектах (без БД): ловит регрессию-утечку финансов при рефакторинге.
 */
const D = (n: number) => new Prisma.Decimal(n);

function makeOrder(financeVisibility: "MAKER_ONLY" | "FULL" = "MAKER_ONLY"): OrderWithRelations {
  const order = {
    id: "o1",
    orderNumber: "DEMO-1001",
    site: { name: "Demo Site", shortName: "DEMO", colorTag: "#64748b", platform: "SHOPIFY" },
    source: "Shopify",
    externalCreatedAt: new Date("2026-07-17T10:00:00Z"),
    updatedAt: new Date("2026-07-17T12:00:00Z"),
    deliveryDate: new Date("2026-07-18T00:00:00Z"),
    deliveryWindow: "12:00 – 16:00",
    senderName: "Sender A",
    senderPhone: "+1 555 0100",
    senderEmail: "sender@example.com",
    recipientName: "Recipient B",
    recipientPhone: "+1 555 0111",
    recipientEmail: "rcpt@example.com",
    addressLine: "1 Rose St",
    apartment: "4",
    city: "Austin",
    zip: "78701",
    cardMessage: "Warm wishes",
    customerNote: "",
    paymentStatus: "PAID",
    orderStatus: "ASSIGNED",
    assignmentStatus: "ASSIGNED",
    deliveryStatus: "PENDING",
    syncStatus: "SYNCED",
    priceMode: "AUTO",
    readyAt: null,
    bouquetPhotoUrl: null,
    deliveryPhotoUrl: null,
    trackingUrl: null,
    currentFloristId: "f1",
    currentFlorist: { financeVisibility, user: { name: "Florist One" } },
    // Финансы владельца
    itemsTotal: D(100),
    tax: D(8),
    tip: D(5),
    discount: D(0),
    deliveryCustomerCost: D(10),
    customerTotal: D(123),
    floristTotal: D(70),
    deliveryActualCost: D(12),
    estimatedProfit: D(18),
    items: [
      {
        id: "it1",
        name: "Roses",
        variantName: "Medium",
        image: null,
        floristCompositionSnapshot: "12 roses",
        quantity: 1,
        options: "",
        externalPrice: D(100),
        floristItemPrice: D(70),
      },
    ],
    assignments: [
      {
        florist: { user: { name: "Florist One" } },
        state: "ASSIGNED",
        priceMode: "AUTO",
        floristTotalSnapshot: D(70),
        assignedAt: new Date("2026-07-17T11:00:00Z"),
        respondedAt: null,
      },
    ],
    messages: [
      { id: "m1", channel: "SMS", direction: "OUTBOUND", party: "RECIPIENT", body: "hi", createdAt: new Date() },
    ],
  };
  return order as unknown as OrderWithRelations;
}

describe("serializeForOwner — видит всё", () => {
  const o = serializeForOwner(makeOrder());
  it("включает полную финансовую раскладку и прибыль", () => {
    expect(o.finance.estimatedProfit).toBe(18);
    expect(o.finance.deliveryActualCost).toBe(12);
    expect(o.finance.customerTotal).toBe(123);
    expect(o.finance.floristTotal).toBe(70);
  });
  it("включает цену клиента и цену флориста по позициям", () => {
    expect(o.items[0].externalPrice).toBe(100);
    expect(o.items[0].floristItemPrice).toBe(70);
  });
  it("включает email отправителя", () => expect(o.senderEmail).toBe("sender@example.com"));
});

describe("serializeForCallCenter — без финансов", () => {
  const o = serializeForCallCenter(makeOrder());
  it("НЕ содержит объект finance", () => {
    expect((o as Record<string, unknown>).finance).toBeUndefined();
  });
  it("позиции НЕ содержат никаких цен", () => {
    const item = o.items[0] as Record<string, unknown>;
    expect(item.externalPrice).toBeUndefined();
    expect(item.floristItemPrice).toBeUndefined();
  });
  it("НЕ раскрывает прибыль/итоги владельца", () => {
    const flat = JSON.stringify(o);
    expect(flat).not.toContain("estimatedProfit");
    expect(flat).not.toContain("deliveryActualCost");
  });
});

describe("serializeForFlorist (MAKER_ONLY) — только своя цена", () => {
  const o = serializeForFlorist(makeOrder("MAKER_ONLY"));
  it("видит свою сумму floristTotal", () => expect(o.floristTotal).toBe(70));
  it("позиция содержит СВОЮ цену, но НЕ цену клиента", () => {
    const item = o.items[0] as Record<string, unknown>;
    expect(item.floristItemPrice).toBe(70);
    expect(item.externalPrice).toBeUndefined();
  });
  it("НЕ содержит finance, прибыль, себестоимость доставки, email отправителя", () => {
    expect((o as Record<string, unknown>).finance).toBeUndefined();
    const flat = JSON.stringify(o);
    expect(flat).not.toContain("estimatedProfit");
    expect(flat).not.toContain("deliveryActualCost");
    expect(flat).not.toContain("sender@example.com");
  });
});

describe("serializeForFlorist (FULL) — расширенная раскладка, но без секретов владельца", () => {
  const o = serializeForFlorist(makeOrder("FULL"));
  it("получает клиентскую раскладку (налог/доставка/итог клиента)", () => {
    expect(o.finance?.customerTotal).toBe(123);
    expect(o.finance?.tax).toBe(8);
  });
  it("ДАЖЕ в FULL не видит прибыль владельца и себестоимость доставки", () => {
    const flat = JSON.stringify(o);
    expect(flat).not.toContain("estimatedProfit");
    expect(flat).not.toContain("deliveryActualCost");
    expect((o.finance as Record<string, unknown>).estimatedProfit).toBeUndefined();
  });
  it("позиция всё ещё без цены клиента", () => {
    expect((o.items[0] as Record<string, unknown>).externalPrice).toBeUndefined();
  });
});
