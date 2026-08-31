import { describe, it, expect } from "vitest";
import { Prisma } from "@/generated/prisma/client";
import {
  orderListInclude,
  serializeOwnerListRow,
  serializeCallCenterListRow,
  serializeFloristListRow,
  type OrderListRow,
} from "./serialize";

/**
 * Строки СПИСКОВ обязаны оставаться лёгкими.
 *
 * История: include был один на карточку и списки, и страница на пятьдесят заказов загружала и
 * сериализовала полную SMS-историю каждого — сотни сообщений, которых список не показывает.
 * Эти тесты не дают тяжёлым связям вернуться в списки молча: добавить поле можно, но осознанно —
 * поменяв и тест.
 */
const D = (v: string) => new Prisma.Decimal(v);

const row = {
  id: "o1",
  orderNumber: "TF-1",
  source: "Website",
  externalCreatedAt: new Date(),
  deliveryDate: new Date("2026-08-20T00:00:00Z"),
  deliveryWindow: "12:00 – 16:00",
  recipientName: "Мария",
  recipientPhone: "+13105550100",
  recipientEmail: null,
  addressLine: "1 Main St",
  apartment: null,
  city: "LA",
  zip: "90017",
  cardMessage: null,
  customerNote: null,
  deliveryInstructions: null,
  paymentStatus: "PAID",
  orderStatus: "CONFIRMED",
  externalStatus: null,
  paymentClassification: null,
  assignmentStatus: "ASSIGNED",
  deliveryStatus: "NOT_STARTED",
  readyAt: null,
  bouquetPhotoUrl: null,
  deliveryPhotoUrl: null,
  trackingUrl: null,
  updatedAt: new Date(),
  itemsTotal: D("100"),
  tax: D("9.5"),
  tip: D("5"),
  discount: D("0"),
  deliveryCustomerCost: D("10"),
  customerTotal: D("124.5"),
  floristTotal: D("40"),
  deliveryActualCost: D("0"),
  site: { name: "TheFlow", shortName: "TF", colorTag: null, platform: "SHOPIFY" },
  items: [
    {
      id: "i1",
      name: "Field of Dreams",
      variantName: null,
      productId: "p1",
      variantId: null,
      image: null,
      parentImageUrl: "https://img/b.jpg",
      variantImageUrl: null,
      floristCompositionSnapshot: null,
      quantity: 1,
      options: "",
      externalPrice: D("100"),
      floristItemPrice: D("40"),
    },
  ],
  currentFlorist: {
    id: "f1",
    avatarUrl: null,
    financeVisibility: "MAKER_ONLY",
    user: { name: "Ольга" },
  },
} as unknown as OrderListRow;

describe("лёгкий include списков", () => {
  it("не содержит переписку, назначения и Airwallex", () => {
    const keys = Object.keys(orderListInclude);
    expect(keys).not.toContain("messages");
    expect(keys).not.toContain("assignments");
    expect(keys).not.toContain("airwallexPayment");
  });
});

describe("строки списков", () => {
  it("ни одна роль не получает в списке переписку или назначения", () => {
    for (const serialized of [
      serializeOwnerListRow(row),
      serializeCallCenterListRow(row),
      serializeFloristListRow(row),
    ]) {
      expect(serialized).not.toHaveProperty("messages");
      expect(serialized).not.toHaveProperty("assignments");
      expect(serialized).not.toHaveProperty("airwallex");
    }
  });

  it("владелец видит в строке обе суммы — таблица их показывает", () => {
    const r = serializeOwnerListRow(row);
    expect(r.finance).toEqual({ customerTotal: 124.5, floristTotal: 40 });
    expect(r.currentFloristName).toBe("Ольга");
  });

  it("колл-центр не получает цен даже в позициях", () => {
    const r = serializeCallCenterListRow(row);
    expect(r.items[0]).not.toHaveProperty("externalPrice");
    expect(r.items[0]).not.toHaveProperty("floristItemPrice");
    expect(r).not.toHaveProperty("finance");
  });

  it("флорист MAKER_ONLY видит свою цену и не видит сумму заказчика", () => {
    const r = serializeFloristListRow(row);
    expect(r.floristTotal).toBe(40);
    expect(r.financeVisibility).toBe("MAKER_ONLY");
    expect(r).not.toHaveProperty("finance");
  });

  it("флорист FULL получает сумму заказчика — список подписывает её «сумма заказа»", () => {
    const full = {
      ...row,
      currentFlorist: { ...row.currentFlorist!, financeVisibility: "FULL" },
    } as unknown as OrderListRow;
    const r = serializeFloristListRow(full);
    expect(r.financeVisibility).toBe("FULL");
    expect(r.finance?.customerTotal).toBe(124.5);
  });

  it("служебная строка Tip не попадает в позиции списка", () => {
    const withTip = {
      ...row,
      items: [
        ...row.items,
        { ...row.items[0], id: "i2", name: "Tip", productId: null, variantId: null, externalPrice: D("5") },
      ],
    } as unknown as OrderListRow;
    expect(serializeOwnerListRow(withTip).items.map((i) => i.name)).toEqual(["Field of Dreams"]);
  });
});
