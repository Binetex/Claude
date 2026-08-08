import { describe, it, expect } from "vitest";
import { Prisma } from "@/generated/prisma/client";
import { serializeForOwner, serializeForFlorist, serializeForCallCenter, type OrderWithRelations } from "./serialize";

/**
 * Служебная строка «Tip» не показывается в списке товаров ни одной роли.
 *
 * Shopify присылает чаевые отдельной позицией line_items, и в карточке появлялся «товар»
 * Tip ×1 с нулевой ценой флориста. Это не товар: за него не платят флористу, он не идёт в
 * закупку и ничего не говорит колл-центру.
 *
 * Отдельный тест, потому что скрытие легко потерять: список позиций собирается в трёх
 * местах, и достаточно забыть одно.
 */
const D = (n: number) => new Prisma.Decimal(n);

const item = (over: Record<string, unknown>) => ({
  id: "x",
  name: "Roses",
  variantName: null,
  image: null,
  parentImageUrl: null,
  variantImageUrl: null,
  floristCompositionSnapshot: null,
  quantity: 1,
  options: "",
  productId: null,
  variantId: null,
  externalPrice: D(100),
  floristItemPrice: D(70),
  ...over,
});

const makeOrder = (items: unknown[]): OrderWithRelations =>
  ({
    id: "o1",
    orderNumber: "DEMO-1",
    site: { name: "S", shortName: "S", colorTag: null, platform: "SHOPIFY" },
    source: "Shopify",
    externalCreatedAt: new Date(),
    updatedAt: new Date(),
    deliveryDate: new Date(),
    deliveryWindow: "12:00 – 16:00",
    senderName: "S",
    senderPhone: "+15550100",
    senderEmail: null,
    recipientName: "R",
    recipientPhone: "+15550111",
    recipientEmail: null,
    addressLine: "1 St",
    apartment: null,
    city: "LA",
    zip: "90001",
    cardMessage: "",
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
    currentFlorist: { financeVisibility: "MAKER_ONLY", avatarUrl: null, user: { name: "F" } },
    itemsTotal: D(100),
    tax: D(0),
    tip: D(10),
    discount: D(0),
    deliveryCustomerCost: D(0),
    customerTotal: D(110),
    floristTotal: D(70),
    deliveryActualCost: null,
    estimatedProfit: D(0),
    items,
    assignments: [],
    messages: [],
  }) as unknown as OrderWithRelations;

const names = (o: { items: { name: string }[] }) => o.items.map((i) => i.name);

const WITH_TIP = [item({ id: "i1" }), item({ id: "i2", name: "Tip", externalPrice: D(10), floristItemPrice: D(0) })];

describe("строка «Tip» скрыта у всех ролей", () => {
  it("владелец", () => {
    expect(names(serializeForOwner(makeOrder(WITH_TIP)))).toEqual(["Roses"]);
  });

  it("флорист", () => {
    expect(names(serializeForFlorist(makeOrder(WITH_TIP)))).toEqual(["Roses"]);
  });

  it("колл-центр", () => {
    expect(names(serializeForCallCenter(makeOrder(WITH_TIP)))).toEqual(["Roses"]);
  });
});

describe("настоящие товары не страдают", () => {
  it("букет со словом Tips в названии остаётся", () => {
    // Имя сравнивается целиком, поэтому «Tulip Tips Bouquet» — обычный товар.
    const o = serializeForOwner(makeOrder([item({ id: "i1", name: "Tulip Tips Bouquet" })]));
    expect(names(o)).toEqual(["Tulip Tips Bouquet"]);
  });

  it("позиция «Tip», связанная с каталогом, остаётся товаром", () => {
    // Связь с каталогом сильнее имени: значит это реальный товар из прайса.
    const o = serializeForOwner(makeOrder([item({ id: "i1", name: "Tip", productId: "p1" })]));
    expect(names(o)).toEqual(["Tip"]);
  });

  it("заказ из одних чаевых даёт пустой список, а не падение", () => {
    expect(names(serializeForOwner(makeOrder([item({ id: "i1", name: "Tip" })])))).toEqual([]);
  });
});

describe("деньги не теряются", () => {
  it("сумма чаевых остаётся в финансах владельца", () => {
    // Чаевые живут в Order.tip, а не в позиции: скрытие строки на суммы не влияет.
    const o = serializeForOwner(makeOrder(WITH_TIP));
    expect(o.finance.tip).toBe(10);
    expect(o.finance.customerTotal).toBe(110);
  });
});
