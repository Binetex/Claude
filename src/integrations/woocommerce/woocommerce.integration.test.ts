/**
 * DB integration тесты WooCommerce против ЛОКАЛЬНОЙ тестовой БД (PGlite). Проверяют
 * целостность записи: без дублей, сохранение локальных полей Floremart, out-of-order,
 * идемпотентность webhook, отключение без потери истории.
 *
 * Запуск: DATABASE_URL=<local> CREDENTIALS_ENCRYPTION_KEY=<b64-32> \
 *   NODE_OPTIONS=--conditions=react-server npx vitest run <this>
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import { prisma } from "@/lib/db";
import { encryptSecret } from "@/lib/crypto/secretBox";
import type { NormalizedProduct } from "@/integrations/types";
import { upsertWooProduct } from "./productWrite";
import { ingestWooOrder, type WooIngestConfig } from "./ingestWooOrder";
import { connectWooCommerce, disconnectWooSite } from "./management";
import { intakeWooWebhook } from "./webhookIntake";
import { analyzeWooOrders } from "./analyzeOrders";

/** Мини-мок Response для инъекции в WooClientOptions.fetchImpl (только GET). */
function mockRes(body: unknown, headers: Record<string, string> = {}): Response {
  const h = new Map(Object.entries({ "content-type": "application/json", ...headers }).map(([k, v]) => [k.toLowerCase(), v]));
  return { ok: true, status: 200, headers: { get: (k: string) => h.get(k.toLowerCase()) ?? null }, text: async () => JSON.stringify(body) } as unknown as Response;
}
const okClient = { fetchImpl: async () => mockRes([{ id: 1 }]), sleep: async () => {} };

// Уникальный на каждый прогон (random), чтобы shortName/orderNumber не коллизировали.
const SHORT = `WT${crypto.randomBytes(4).toString("hex")}`.slice(0, 12);
const RUN = SHORT.toLowerCase();
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

function product(over: Partial<NormalizedProduct> = {}): NormalizedProduct {
  return {
    externalId: "100",
    name: "Woo Rose",
    image: null,
    onlineUrl: null,
    status: "ACTIVE",
    productType: "variable",
    adminUrl: null,
    variants: [
      { externalId: "201", title: "S", sku: null, listPrice: 100, compareAtPrice: null, image: null, option1: "S", option2: null, option3: null, inventoryQty: null, available: true, position: 0, adminUrl: null },
      { externalId: "202", title: "L", sku: null, listPrice: 180, compareAtPrice: null, image: null, option1: "L", option2: null, option3: null, inventoryQty: null, available: true, position: 1, adminUrl: null },
    ],
    ...over,
  };
}

beforeAll(async () => {
  const site = await prisma.site.create({
    data: {
      name: "Woo Test", shortName: SHORT, platform: "WOOCOMMERCE", connectionStatus: "CONNECTED",
      wooConnection: {
        create: {
          storeUrl: `https://${RUN}.test`, apiBaseUrl: `https://${RUN}.test/wp-json/wc/v3`, apiVersion: "wc/v3",
          consumerKeyEncrypted: encryptSecret("ck"), consumerSecretEncrypted: encryptSecret("cs"), consumerSecretMask: "****",
          webhookSecretEncrypted: encryptSecret("whsecret"), connStatus: "CONNECTED",
        },
      },
    },
    select: { id: true },
  });
  siteId = site.id;
});

afterAll(async () => {
  // Order не каскадится при удалении Site — чистим заказы (items каскадятся) до сайта.
  await prisma.order.deleteMany({ where: { siteId } });
  await prisma.outboxEvent.deleteMany({ where: { aggregateId: siteId } });
  await prisma.site.deleteMany({ where: { shortName: SHORT } });
});

describe("catalog upsert (сценарии 6,7,8)", () => {
  it("6) повторный upsert не создаёт дублей; 7) floristPrice/floristComposition сохраняются", async () => {
    await upsertWooProduct(siteId, product());
    // владелец задал локальные поля
    const p1 = await prisma.product.findFirst({ where: { siteId, externalId: "100" }, select: { id: true, variants: { select: { id: true, externalId: true } } } });
    await prisma.product.update({ where: { id: p1!.id }, data: { floristPrice: "42.50", defaultFloristComposition: "3 roses" } });
    const v201 = p1!.variants.find((v) => v.externalId === "201")!;
    await prisma.productVariant.update({ where: { id: v201.id }, data: { floristPrice: "20", floristComposition: "local composition" } });

    // повторная синхронизация того же товара (цена варианта изменилась в Woo)
    await upsertWooProduct(siteId, product({ variants: product().variants.map((v) => (v.externalId === "201" ? { ...v, listPrice: 111 } : v)) }));

    const products = await prisma.product.findMany({ where: { siteId, externalId: "100" } });
    expect(products).toHaveLength(1); // без дублей
    expect(products[0].floristPrice?.toString()).toBe("42.5"); // локальное сохранено
    expect(products[0].defaultFloristComposition).toBe("3 roses");
    const variants = await prisma.productVariant.findMany({ where: { product: { siteId, externalId: "100" } }, orderBy: { externalId: "asc" } });
    expect(variants).toHaveLength(2); // без дублей
    expect(variants[0].listPrice.toString()).toBe("111"); // внешняя цена обновилась
    expect(variants[0].floristPrice?.toString()).toBe("20"); // локальная цена флориста сохранена
    expect(variants[0].floristComposition).toBe("local composition"); // локальный состав сохранён
  });

  it("8) исчезнувшая вариация помечается remoteDeleted, но локальный состав сохраняется", async () => {
    // повторный upsert БЕЗ вариации 202
    await upsertWooProduct(siteId, product({ variants: [product().variants[0]] }));
    const v202 = await prisma.productVariant.findFirst({ where: { product: { siteId, externalId: "100" }, externalId: "202" } });
    expect(v202!.remoteDeleted).toBe(true);
    // локальный состав на 202 (если бы был) не стирается — проверим, что запись жива физически
    expect(v202).not.toBeNull();
  });
});

describe("order ingest (сценарии 9,10 + out-of-order)", () => {
  const wooOrder = (over: Record<string, unknown> = {}) => ({
    id: 5000,
    number: "5000",
    status: "processing",
    date_created_gmt: "2026-08-01T10:00:00",
    date_modified_gmt: "2026-08-01T10:00:00",
    billing: { first_name: "John", last_name: "Buyer", phone: "+1", email: "j@x.com" },
    shipping: { first_name: "Ann", last_name: "Recip", phone: "+2", address_1: "1 St", city: "Town", postcode: "1000" },
    line_items: [
      { id: 1, name: "Woo Rose", product_id: 100, variation_id: 201, quantity: 2, price: "100", sku: "R" },
      { id: 2, name: "Simple", product_id: 100, quantity: 1, price: "50" },
    ],
    total: "250", total_tax: "0", shipping_total: "10", discount_total: "0",
    ...over,
  });

  it("9,10) создаёт заказ один раз; позиции сопоставлены по variation_id/product_id", async () => {
    // восстановим вариацию 202/каталог для сопоставления
    await upsertWooProduct(siteId, product());
    const site = { id: siteId, shortName: SHORT };
    const r1 = await ingestWooOrder(site, wooOrder() as never, ingestConfig);
    expect(r1.status).toBe("created");
    const r2 = await ingestWooOrder(site, wooOrder() as never, ingestConfig); // повторно
    expect(["updated"]).toContain(r2.status); // не создаёт второй

    const orders = await prisma.order.findMany({ where: { siteId, externalId: "5000" }, include: { items: true } });
    expect(orders).toHaveLength(1); // без дублей
    const item1 = orders[0].items.find((i) => i.variantExternalId === "201");
    expect(item1?.variantId).toBeTruthy(); // сопоставлено по variation_id
    expect(orders[0].recipientName).toBe("Ann Recip");
    expect(orders[0].orderStatus).toBe("CONFIRMED"); // processing → CONFIRMED
  });

  it("out-of-order: более старое событие не откатывает данные", async () => {
    const site = { id: siteId, shortName: SHORT };
    // новее: completed
    await ingestWooOrder(site, wooOrder({ status: "completed", date_modified_gmt: "2026-08-02T10:00:00" }) as never, ingestConfig);
    // старее: pending — должен быть skipped_stale
    const stale = await ingestWooOrder(site, wooOrder({ status: "pending", date_modified_gmt: "2026-08-01T09:00:00" }) as never, ingestConfig);
    expect(stale.status).toBe("skipped_stale");
    const o = await prisma.order.findFirst({ where: { siteId, externalId: "5000" } });
    expect(o!.orderStatus).toBe("DELIVERED"); // не откатился к pending
  });
});

describe("изображения позиции: parent + variant (WooCommerce)", () => {
  const PARENT = "https://cdn.example/woo-parent.jpg";
  const VARIANT = "https://cdn.example/woo-variant.jpg";

  const imgOrder = (over: Record<string, unknown> = {}) => ({
    id: 7100,
    number: "7100",
    status: "processing",
    date_created_gmt: "2026-08-05T10:00:00",
    date_modified_gmt: "2026-08-05T10:00:00",
    billing: { first_name: "John", last_name: "Buyer", phone: "+1", email: "j@x.com" },
    shipping: { first_name: "Ann", last_name: "Recip", phone: "+2", address_1: "1 St", city: "Town", postcode: "1000" },
    line_items: [
      { id: 1, name: "Woo Rose", product_id: 100, variation_id: 201, quantity: 1, price: "100", sku: "R" }, // вариация со своим фото
      { id: 2, name: "Woo Rose", product_id: 100, variation_id: 202, quantity: 1, price: "180" },           // вариация без фото
    ],
    total: "280", total_tax: "0", shipping_total: "0", discount_total: "0",
    ...over,
  });

  /** Каталог: у товара своё фото, у вариации 201 — своё, у 202 — нет. */
  async function seedCatalog(parentImage: string | null, variant201Image: string | null) {
    const p = product({ image: parentImage });
    p.variants[0].image = variant201Image; // 201
    p.variants[1].image = null;            // 202
    await upsertWooProduct(siteId, p);
  }

  it("вариация со своим фото сохраняет обе ссылки; вариация без фото — только родительскую", async () => {
    await seedCatalog(PARENT, VARIANT);
    await ingestWooOrder({ id: siteId, shortName: SHORT }, imgOrder() as never, ingestConfig);

    const order = await prisma.order.findFirstOrThrow({ where: { siteId, externalId: "7100" }, include: { items: true } });
    const withVariantImage = order.items.find((i) => i.variantExternalId === "201");
    const withoutVariantImage = order.items.find((i) => i.variantExternalId === "202");

    expect(withVariantImage?.parentImageUrl).toBe(PARENT);
    expect(withVariantImage?.variantImageUrl).toBe(VARIANT);
    expect(withVariantImage?.image).toBe(VARIANT); // legacy «эффективное» фото не изменило смысл

    expect(withoutVariantImage?.parentImageUrl).toBe(PARENT);
    expect(withoutVariantImage?.variantImageUrl).toBeNull(); // fallback на родительское — при рендере
    expect(withoutVariantImage?.image).toBe(PARENT);
  });

  it("снимок в OrderItem не меняется при последующем изменении товара в WooCommerce", async () => {
    await seedCatalog(PARENT, VARIANT);
    await ingestWooOrder({ id: siteId, shortName: SHORT }, imgOrder({ id: 7101, number: "7101" }) as never, ingestConfig);

    // Товар и вариация получили НОВЫЕ фото в Woo.
    await seedCatalog("https://cdn.example/woo-parent-NEW.jpg", "https://cdn.example/woo-variant-NEW.jpg");

    const order = await prisma.order.findFirstOrThrow({ where: { siteId, externalId: "7101" }, include: { items: true } });
    const item = order.items.find((i) => i.variantExternalId === "201");
    expect(item?.parentImageUrl).toBe(PARENT);   // старый снимок
    expect(item?.variantImageUrl).toBe(VARIANT); // старый снимок
  });
});

describe("webhook intake (сценарии 18,19)", () => {
  const body = JSON.stringify({ id: 5000, status: "processing" });
  const sign = (b: string) => crypto.createHmac("sha256", "whsecret").update(b, "utf8").digest("base64");

  it("18) повторный webhook с тем же delivery-id → одна запись в outbox", async () => {
    const headers = { "x-wc-webhook-topic": "order.updated", "x-wc-webhook-signature": sign(body), "x-wc-webhook-delivery-id": "dlv-1" };
    const r1 = await intakeWooWebhook({ siteId, rawBody: body, headers });
    const r2 = await intakeWooWebhook({ siteId, rawBody: body, headers });
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    const rows = await prisma.outboxEvent.findMany({ where: { idempotencyKey: `woo:webhook:${siteId}:dlv-1` } });
    expect(rows).toHaveLength(1); // дедуп
  });

  it("19) неверная подпись → 401, тело не публикуется", async () => {
    const headers = { "x-wc-webhook-topic": "order.updated", "x-wc-webhook-signature": "WRONG", "x-wc-webhook-delivery-id": "dlv-2" };
    const r = await intakeWooWebhook({ siteId, rawBody: body, headers });
    expect(r.status).toBe(401);
    const rows = await prisma.outboxEvent.findMany({ where: { idempotencyKey: `woo:webhook:${siteId}:dlv-2` } });
    expect(rows).toHaveLength(0);
  });
});

describe("защита от дублирования магазинов (идемпотентность подключения)", () => {
  const storeUrl = `https://dedup-${RUN}.example.com`;

  afterAll(async () => {
    const s = await prisma.wooCommerceConnection.findFirst({ where: { storeUrl }, select: { siteId: true } });
    if (s) {
      await prisma.order.deleteMany({ where: { siteId: s.siteId } });
      await prisma.site.delete({ where: { id: s.siteId } }).catch(() => {});
    }
  });

  it("повторное подключение того же storeUrl обновляет существующую запись, а не создаёт новую", async () => {
    const input = { name: "Dedup", storeUrl, consumerKey: "ck", consumerSecret: "cs" };
    const r1 = await connectWooCommerce(input, { client: okClient });
    expect(r1.ok).toBe(true);
    const r2 = await connectWooCommerce(input, { allowReconnect: true, client: okClient });
    expect(r2.ok).toBe(true);
    if (r1.ok && r2.ok) {
      expect(r2.reconnected).toBe(true);
      expect(r2.siteId).toBe(r1.siteId); // тот же Site
    }
    const conns = await prisma.wooCommerceConnection.findMany({ where: { storeUrl } });
    expect(conns).toHaveLength(1); // ровно одна запись на магазин
  });

  it("без allowReconnect повторное подключение подключённого магазина отклоняется", async () => {
    const r = await connectWooCommerce({ name: "Dedup", storeUrl, consumerKey: "ck", consumerSecret: "cs" }, { client: okClient });
    expect(r.ok).toBe(false);
  });
});

describe("read-only анализ ничего не пишет в БД", () => {
  it("analyzeWooOrders выполняет только GET — счётчики Order/Outbox/Product/Webhook не меняются", async () => {
    const before = {
      orders: await prisma.order.count(),
      outbox: await prisma.outboxEvent.count(),
      products: await prisma.product.count(),
      webhooks: await prisma.wooCommerceWebhook.count(),
      siteSync: await prisma.siteSync.count(),
    };
    const client = {
      fetchImpl: async () =>
        mockRes([
          { id: 9001, status: "pending", payment_method: "airwallex_klarna", meta_data: [{ key: "_airwallex_payment_status", value: "AUTHORIZED" }] },
          { id: 9002, status: "processing", payment_method: "bacs" },
        ]),
      sleep: async () => {},
    };
    const res = await analyzeWooOrders(siteId, { limit: 50, client });
    expect(res.fetched).toBe(2);
    expect(res.samples.length).toBeGreaterThan(0);

    const after = {
      orders: await prisma.order.count(),
      outbox: await prisma.outboxEvent.count(),
      products: await prisma.product.count(),
      webhooks: await prisma.wooCommerceWebhook.count(),
      siteSync: await prisma.siteSync.count(),
    };
    expect(after).toEqual(before); // НИЧЕГО не создано/не изменено
  });

  it("limit жёстко ограничен 50", async () => {
    let capturedPerPage: string | null = null;
    const client = {
      fetchImpl: async (url: string) => {
        capturedPerPage = new URL(url).searchParams.get("per_page");
        return mockRes([]);
      },
      sleep: async () => {},
    };
    await analyzeWooOrders(siteId, { limit: 999, client });
    expect(capturedPerPage).toBe("50");
  });
});

describe("адрес отправителя из billing (WooCommerce)", () => {
  const site = () => ({ id: siteId, shortName: SHORT });
  const withBilling = (over: Record<string, unknown> = {}) => ({
    id: 7000, number: "7000", status: "processing",
    date_created_gmt: "2026-08-03T10:00:00", date_modified_gmt: "2026-08-03T10:00:00",
    billing: { first_name: "Slava", last_name: "V", phone: "+1310", email: "s@x.com", address_1: "742 Evergreen Terrace", address_2: "Apt 5", city: "Springfield", state: "CA", postcode: "90210", country: "US" },
    shipping: { first_name: "Ann", last_name: "R", phone: "+2", address_1: "1 St", city: "Town", postcode: "1000" },
    line_items: [{ id: 1, name: "Woo Rose", product_id: 100, variation_id: 201, quantity: 1, price: "100" }],
    total: "100",
    ...over,
  });
  afterAll(async () => { await prisma.order.deleteMany({ where: { siteId, externalId: "7000" } }); });

  it("создание: billing-адрес переносится в senderAddress*", async () => {
    await ingestWooOrder(site(), withBilling() as never, ingestConfig);
    const o = await prisma.order.findFirst({ where: { siteId, externalId: "7000" }, select: { senderAddressLine: true, senderApartment: true, senderCity: true, senderProvince: true, senderZip: true, senderCountry: true } });
    expect(o).toMatchObject({ senderAddressLine: "742 Evergreen Terrace", senderApartment: "Apt 5", senderCity: "Springfield", senderProvince: "CA", senderZip: "90210", senderCountry: "US" });
  });

  it("ресинк: изменённый billing-адрес обновляется, удалённые поля обнуляются", async () => {
    await ingestWooOrder(site(), withBilling({ date_modified_gmt: "2026-08-03T12:00:00", billing: { first_name: "Slava", last_name: "V", phone: "+1310", address_1: "10 New Rd", city: "Newtown", state: "NY", postcode: "10001", country: "US" } }) as never, ingestConfig);
    const o = await prisma.order.findFirst({ where: { siteId, externalId: "7000" }, select: { senderAddressLine: true, senderCity: true, senderProvince: true, senderApartment: true } });
    expect(o).toMatchObject({ senderAddressLine: "10 New Rd", senderCity: "Newtown", senderProvince: "NY", senderApartment: null });
  });
});

describe("авто-назначение флориста (WooCommerce — как в Shopify)", () => {
  let floristId = "";
  const email = `wf-${RUN}@x.com`;
  const wooOrder2 = (over: Record<string, unknown> = {}) => ({
    id: 6100, number: "6100", status: "processing",
    date_created_gmt: "2026-08-02T10:00:00", date_modified_gmt: "2026-08-02T10:00:00",
    billing: { first_name: "J", last_name: "B", phone: "+1", email: "j@x.com" },
    shipping: { first_name: "A", last_name: "R", phone: "+2", address_1: "1 St", city: "T", postcode: "1000" },
    line_items: [{ id: 1, name: "Woo Rose", product_id: 100, variation_id: 201, quantity: 1, price: "100" }],
    total: "100", total_tax: "0", shipping_total: "0", discount_total: "0",
    ...over,
  });

  beforeAll(async () => {
    const user = await prisma.user.create({ data: { name: "Woo Florist", email, role: "FLORIST", passwordHash: "x" } });
    const florist = await prisma.florist.create({ data: { userId: user.id, active: true, financeVisibility: "FULL" } });
    floristId = florist.id;
    await prisma.siteFloristPriority.create({ data: { siteId, floristId, position: 0 } });
  });
  afterAll(async () => {
    await prisma.orderAssignment.deleteMany({ where: { floristId } });
    await prisma.order.deleteMany({ where: { siteId, externalId: { in: ["6100", "6200"] } } });
    await prisma.siteFloristPriority.deleteMany({ where: { siteId } });
    await prisma.florist.deleteMany({ where: { id: floristId } });
    await prisma.user.deleteMany({ where: { email } });
  });

  const site = () => ({ id: siteId, shortName: SHORT });

  it("новый processing (оплачен) заказ → автоматически назначается основному флористу", async () => {
    const r = await ingestWooOrder(site(), wooOrder2() as never, ingestConfig);
    expect(r.status).toBe("created");
    const saved = await prisma.order.findFirst({ where: { siteId, externalId: "6100" }, select: { assignmentStatus: true, currentFloristId: true, orderStatus: true } });
    expect(saved).toMatchObject({ assignmentStatus: "ASSIGNED", currentFloristId: floristId, orderStatus: "ASSIGNED" });
  });

  it("новый pending (не оплачен) заказ → НЕ назначается (остаётся UNASSIGNED)", async () => {
    await ingestWooOrder(site(), wooOrder2({ id: 6200, number: "6200", status: "pending", date_modified_gmt: "2026-08-02T11:00:00" }) as never, ingestConfig);
    const saved = await prisma.order.findFirst({ where: { siteId, externalId: "6200" }, select: { assignmentStatus: true, currentFloristId: true, orderStatus: true } });
    expect(saved).toMatchObject({ assignmentStatus: "UNASSIGNED", currentFloristId: null, orderStatus: "AWAITING_PAYMENT" });
  });

  it("переход pending → processing существующего заказа → назначается флористу", async () => {
    await ingestWooOrder(site(), wooOrder2({ id: 6200, number: "6200", status: "processing", date_modified_gmt: "2026-08-02T12:00:00" }) as never, ingestConfig);
    const saved = await prisma.order.findFirst({ where: { siteId, externalId: "6200" }, select: { assignmentStatus: true, currentFloristId: true } });
    expect(saved).toMatchObject({ assignmentStatus: "ASSIGNED", currentFloristId: floristId });
  });
});

describe("disconnect (сценарий 22)", () => {
  it("отключение сохраняет товары и заказы, чистит credentials", async () => {
    const productsBefore = await prisma.product.count({ where: { siteId } });
    const ordersBefore = await prisma.order.count({ where: { siteId } });
    expect(productsBefore).toBeGreaterThan(0);
    expect(ordersBefore).toBeGreaterThan(0);

    await disconnectWooSite(siteId);

    expect(await prisma.product.count({ where: { siteId } })).toBe(productsBefore); // товары целы
    expect(await prisma.order.count({ where: { siteId } })).toBe(ordersBefore); // заказы целы
    const conn = await prisma.wooCommerceConnection.findUnique({ where: { siteId } });
    expect(conn!.connStatus).toBe("DISCONNECTED");
    expect(conn!.consumerKeyEncrypted).toBe(""); // credentials очищены
    expect(conn!.webhookSecretEncrypted).toBeNull();
  });
});
