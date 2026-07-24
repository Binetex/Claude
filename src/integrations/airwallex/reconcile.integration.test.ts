/**
 * Airwallex Monitoring на реальной БД (throwaway prisma dev). Сеть замокана по URL:
 * api.airwallex.com — платежи, всё остальное — WooCommerce.
 *
 * Здесь проверяется то, что нельзя покрыть чистыми тестами policy: работа с БД, дедуп задач
 * между воркерами, политика записи журнала и режим наблюдения (business status не меняется).
 */
import { describe, it, expect, afterAll, beforeEach, vi } from "vitest";
import { prisma } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";

process.env.CREDENTIALS_ENCRYPTION_KEY ||= Buffer.alloc(32, 9).toString("base64");

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

const { reconcileAirwallexPayment, upsertAirwallexPayment, onWooOrderIngestedForAirwallex } = await import("./reconcile");
const { dispatchAirwallexChecks } = await import("./dispatcher");
const { saveAirwallexSettings } = await import("./settings");
const { AIRWALLEX_VERIFY_EVENT } = await import("./events");
const { encryptSecret } = await import("@/lib/crypto/secretBox");

const suffix = `awb-${Date.now()}`;
const siteIds: string[] = [];
const orderIds: string[] = [];

// Настоящий Response: wooGet читает ok/headers/text(), урезанный объект его ломает.
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const LOGIN = { token: "tok", expires_at: new Date(Date.now() + 30 * 60_000).toISOString() };

/** Ответы Airwallex по intent; Woo — отдельно. */
function wireApi(opts: { intent?: unknown; intentStatus?: number; woo?: unknown; wooStatus?: number } = {}) {
  fetchMock.mockImplementation(async (url: string) => {
    const u = String(url);
    if (u.includes("/authentication/login")) return json(201, LOGIN);
    if (u.includes("/pa/payment_intents/")) return json(opts.intentStatus ?? 200, opts.intent ?? { status: "PENDING" });
    return json(opts.wooStatus ?? 200, opts.woo ?? { payment_method: "airwallex_card", date_paid: null, transaction_id: null });
  });
}

async function makeSite(monitoring = true) {
  const site = await prisma.site.create({ data: { name: `AW ${suffix}-${siteIds.length}`, shortName: `AWB${siteIds.length}`, platform: "WOOCOMMERCE" } });
  siteIds.push(site.id);
  await prisma.wooCommerceConnection.create({
    data: {
      siteId: site.id, storeUrl: `https://awb-${suffix}-${siteIds.length}.example`, apiBaseUrl: "https://awb.example/wp-json/wc/v3",
      apiVersion: "wc/v3", consumerKeyEncrypted: encryptSecret("ck_test"), consumerSecretEncrypted: encryptSecret("cs_test"), consumerSecretMask: "****",
      airwallexPendingThresholdMin: 15,
    },
  });
  await saveAirwallexSettings(prisma, site.id, { clientId: "cid", apiKey: "akey", env: "prod" });
  if (monitoring) {
    await prisma.wooCommerceConnection.update({ where: { siteId: site.id }, data: { airwallexApiVerifiedAt: new Date(), airwallexMonitoringEnabled: true } });
  }
  return site.id;
}

async function makeOrder(siteId: string, over: Partial<Prisma.OrderUncheckedCreateInput> = {}) {
  const o = await prisma.order.create({
    data: {
      orderNumber: `AWB-${orderIds.length}-${suffix}`, siteId, platform: "WOOCOMMERCE", source: "Woo",
      externalId: `9${orderIds.length}${Date.now() % 10000}`,
      externalCreatedAt: new Date(), deliveryDate: new Date(), deliveryWindow: "12:00 – 16:00",
      senderName: "A", senderPhone: "+1", recipientName: "B", recipientPhone: "+2",
      addressLine: "1 St", city: "LA", zip: "90001",
      itemsTotal: new Prisma.Decimal(10), customerTotal: new Prisma.Decimal(10),
      paymentMethod: "airwallex_card", paymentStatus: "UNPAID", orderStatus: "AWAITING_PAYMENT",
      externalStatus: "airwallex-pending",
      ...over,
    },
  });
  orderIds.push(o.id);
  return o;
}

/** Создаёт запись мониторинга «постарше», чтобы не срабатывал молодой-возраст guard. */
async function withPayment(orderId: string, siteId: string, over: Prisma.AirwallexPaymentUncheckedUpdateInput = {}) {
  await upsertAirwallexPayment(prisma, { orderId, siteId, paymentIntentId: "int_1", paymentMethod: "airwallex_card" });
  await prisma.airwallexPayment.update({
    where: { orderId },
    data: { firstSeenAt: new Date(Date.now() - 3 * 60 * 60_000), ...over },
  });
}

const rec = (orderId: string) => prisma.airwallexPayment.findUniqueOrThrow({ where: { orderId } });
const checks = (orderId: string) => prisma.airwallexCheck.findMany({ where: { orderId }, orderBy: { checkedAt: "asc" } });
const tgEvents = (orderId: string) =>
  prisma.outboxEvent.findMany({ where: { aggregateId: orderId, eventType: "telegram.notify" } });

beforeEach(() => fetchMock.mockReset());

afterAll(async () => {
  await prisma.outboxEvent.deleteMany({ where: { aggregateId: { in: orderIds } } });
  await prisma.airwallexCheck.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.airwallexPayment.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  await prisma.wooCommerceConnection.deleteMany({ where: { siteId: { in: siteIds } } });
  await prisma.site.deleteMany({ where: { id: { in: siteIds } } });
  await prisma.$disconnect();
});

describe("приём заказа", () => {
  it("Airwallex-заказ → создаётся запись с intent id и задача сверки", async () => {
    const siteId = await makeSite();
    const order = await makeOrder(siteId);
    await onWooOrderIngestedForAirwallex(prisma, {
      orderId: order.id, siteId, paymentMethod: "airwallex_klarna",
      meta: [{ key: "_tmp_airwallex_payment_intent", value: "int_abc" }],
    });

    const r = await rec(order.id);
    expect(r).toMatchObject({ paymentIntentId: "int_abc", monitoringActive: true });
    expect(r.stopCheckingAt).not.toBeNull(); // потолок ставится СРАЗУ при создании
    const jobs = await prisma.outboxEvent.findMany({ where: { aggregateId: order.id, eventType: AIRWALLEX_VERIFY_EVENT } });
    expect(jobs).toHaveLength(1);
  });

  it("backfill старого заказа: потолок считается от даты заказа, а не от момента вставки", async () => {
    const siteId = await makeSite();
    const order = await makeOrder(siteId);
    const created = new Date(Date.now() - 2 * 24 * 60 * 60_000); // заказ двухдневной давности

    await upsertAirwallexPayment(prisma, {
      orderId: order.id, siteId, paymentIntentId: "int_old", paymentMethod: "airwallex_card", firstSeenAt: created,
    });

    const r = await rec(order.id);
    expect(r.firstSeenAt.getTime()).toBe(created.getTime());
    // 7 дней от даты заказа → остаётся 5, а не 7: старый заказ не получает полный срок заново.
    const daysLeft = (r.stopCheckingAt!.getTime() - Date.now()) / (24 * 60 * 60_000);
    expect(Math.round(daysLeft)).toBe(5);
  });

  it("не-Airwallex gateway → запись не создаётся (#20295)", async () => {
    const siteId = await makeSite();
    const order = await makeOrder(siteId, { paymentMethod: "ppcp-gateway" });
    await onWooOrderIngestedForAirwallex(prisma, {
      orderId: order.id, siteId, paymentMethod: "ppcp-gateway",
      meta: [{ key: "_tmp_airwallex_payment_intent", value: "int_ghost" }],
    });
    expect(await prisma.airwallexPayment.findUnique({ where: { orderId: order.id } })).toBeNull();
  });

  it("мониторинг выключен у сайта → запись не создаётся", async () => {
    const siteId = await makeSite(false);
    const order = await makeOrder(siteId);
    await onWooOrderIngestedForAirwallex(prisma, {
      orderId: order.id, siteId, paymentMethod: "airwallex_card",
      meta: [{ key: "_tmp_airwallex_payment_intent", value: "int_x" }],
    });
    expect(await prisma.airwallexPayment.findUnique({ where: { orderId: order.id } })).toBeNull();
  });

  it("новый intent = новая попытка: состояние сбрасывается, старое уходит в журнал", async () => {
    const siteId = await makeSite();
    const order = await makeOrder(siteId);
    await withPayment(order.id, siteId);
    await prisma.airwallexPayment.update({ where: { orderId: order.id }, data: { normalizedStatus: "FAILED", failedAlertAttemptId: "att_1", monitoringActive: false } });

    await onWooOrderIngestedForAirwallex(prisma, {
      orderId: order.id, siteId, paymentMethod: "airwallex_card",
      meta: [{ key: "_tmp_airwallex_payment_intent", value: "int_2" }],
    });

    const r = await rec(order.id);
    expect(r).toMatchObject({ paymentIntentId: "int_2", normalizedStatus: null, failedAlertAttemptId: null, monitoringActive: true });
    expect((await checks(order.id)).some((c) => c.outcome === "intent_replaced")).toBe(true);
  });
});

describe("жизненный цикл FAILED → контрольная → 6ч → новая попытка → PAID", () => {
  it("проходит весь путь и завершается PAID", async () => {
    const siteId = await makeSite();
    const order = await makeOrder(siteId);
    await withPayment(order.id, siteId);

    // 1) первый FAILED → алерт + контрольная через 30 мин
    wireApi({ intent: { status: "REQUIRES_PAYMENT_METHOD", latest_payment_attempt: { id: "att_1", status: "FAILED" } } });
    await reconcileAirwallexPayment(prisma, order.id);
    let r = await rec(order.id);
    expect(r.normalizedStatus).toBe("FAILED");
    expect(r.monitoringActive).toBe(true);
    expect(Math.round((r.nextCheckAt!.getTime() - Date.now()) / 60_000)).toBe(30);
    expect((await tgEvents(order.id)).length).toBe(1); // payment.failed один раз

    // 2) контрольная, та же попытка → без повторного алерта, переход на 6 часов
    await reconcileAirwallexPayment(prisma, order.id);
    r = await rec(order.id);
    expect(Math.round((r.nextCheckAt!.getTime() - Date.now()) / 60_000)).toBe(360);
    expect((await tgEvents(order.id)).length).toBe(1); // не задвоилось

    // 3) новая попытка удалась → PAID и полная остановка
    wireApi({ intent: { status: "SUCCEEDED", latest_payment_attempt: { id: "att_2", status: "CAPTURED" }, captured_amount: 10 } });
    await reconcileAirwallexPayment(prisma, order.id);
    r = await rec(order.id);
    expect(r).toMatchObject({ normalizedStatus: "PAID", monitoringActive: false, nextCheckAt: null });
  });
});

describe("режим наблюдения", () => {
  it("business status заказа НЕ меняется даже при PAID в Airwallex", async () => {
    const siteId = await makeSite();
    const order = await makeOrder(siteId);
    await withPayment(order.id, siteId);
    wireApi({
      intent: { status: "SUCCEEDED", latest_payment_attempt: { id: "a", status: "CAPTURED" } },
      woo: { payment_method: "airwallex_card", date_paid: "2026-07-24T10:00:00", transaction_id: "int_1" },
    });

    await reconcileAirwallexPayment(prisma, order.id);

    const after = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.paymentStatus).toBe("UNPAID"); // как было
    expect(after.orderStatus).toBe("AWAITING_PAYMENT");
    expect(after.paymentClassification).toBeNull();
    expect(after.currentFloristId).toBeNull(); // назначения нет
  });
});

describe("смена gateway", () => {
  it("заказ ушёл на другой шлюз → мониторинг останавливается, алертов нет", async () => {
    const siteId = await makeSite();
    const order = await makeOrder(siteId);
    await withPayment(order.id, siteId);
    await prisma.order.update({ where: { id: order.id }, data: { paymentMethod: "ppcp-gateway" } });
    wireApi({ intent: { status: "REQUIRES_PAYMENT_METHOD", latest_payment_attempt: { id: "a", status: "FAILED" } } });

    const res = await reconcileAirwallexPayment(prisma, order.id);

    expect(res.outcome).toBe("skipped_gateway");
    expect((await rec(order.id)).monitoringActive).toBe(false);
    expect(await tgEvents(order.id)).toHaveLength(0);
    // В Airwallex вообще не ходили
    expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes("payment_intents"))).toHaveLength(0);
  });
});

describe("mismatch — ленивый Woo-запрос", () => {
  it("Airwallex PAID, Woo не знает об оплате → mismatch и уведомление", async () => {
    const siteId = await makeSite();
    const order = await makeOrder(siteId);
    await withPayment(order.id, siteId);
    wireApi({
      intent: { status: "SUCCEEDED", latest_payment_attempt: { id: "a", status: "CAPTURED" } },
      woo: { payment_method: "airwallex_card", date_paid: null, transaction_id: null },
    });

    const res = await reconcileAirwallexPayment(prisma, order.id);
    expect(res.outcome).toContain("mismatch:airwallex_paid_woo_unpaid");
    const evs = await tgEvents(order.id);
    expect(evs.some((e) => String(e.idempotencyKey).includes("payment.status_mismatch"))).toBe(true);
  });

  it("ошибка Woo API НЕ создаёт mismatch — только safeError", async () => {
    const siteId = await makeSite();
    const order = await makeOrder(siteId);
    await withPayment(order.id, siteId);
    wireApi({
      intent: { status: "SUCCEEDED", latest_payment_attempt: { id: "a", status: "CAPTURED" } },
      wooStatus: 500, woo: { message: "boom" },
    });

    const res = await reconcileAirwallexPayment(prisma, order.id);

    expect(res.outcome).not.toContain("mismatch");
    const evs = await tgEvents(order.id);
    expect(evs.some((e) => String(e.idempotencyKey).includes("payment.status_mismatch"))).toBe(false);
    expect((await rec(order.id)).safeError).toContain("Woo API");
  });

  it("статусы согласуются → в Woo не ходим вовсе", async () => {
    const siteId = await makeSite();
    const order = await makeOrder(siteId);
    await withPayment(order.id, siteId);
    wireApi({ intent: { status: "PENDING" } });

    await reconcileAirwallexPayment(prisma, order.id);
    expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes("/wc/v3/"))).toHaveLength(0);
  });
});

describe("журнал не засоряется", () => {
  it("неизменный pending: первая запись есть, повторные — нет", async () => {
    const siteId = await makeSite();
    const order = await makeOrder(siteId);
    await withPayment(order.id, siteId);
    wireApi({ intent: { status: "PENDING", latest_payment_attempt: { id: "a", status: "AUTHORIZED" } } });

    await reconcileAirwallexPayment(prisma, order.id);
    expect(await checks(order.id)).toHaveLength(1);

    await reconcileAirwallexPayment(prisma, order.id);
    await reconcileAirwallexPayment(prisma, order.id);
    expect(await checks(order.id)).toHaveLength(1); // ничего не изменилось — журнал не растёт

    // смена статуса — запись появляется
    wireApi({ intent: { status: "SUCCEEDED", latest_payment_attempt: { id: "a", status: "CAPTURED" } } });
    await reconcileAirwallexPayment(prisma, order.id);
    expect((await checks(order.id)).length).toBeGreaterThan(1);
  });
});

describe("диспетчер", () => {
  it("два воркера в одном тике не создают дублей задач", async () => {
    const siteId = await makeSite();
    const order = await makeOrder(siteId);
    await withPayment(order.id, siteId);
    await prisma.airwallexPayment.update({ where: { orderId: order.id }, data: { nextCheckAt: new Date(Date.now() - 60_000) } });
    await prisma.outboxEvent.deleteMany({ where: { aggregateId: order.id, eventType: AIRWALLEX_VERIFY_EVENT } });

    // Одновременный проход двух экземпляров воркера.
    const [a, b] = await Promise.all([dispatchAirwallexChecks(prisma), dispatchAirwallexChecks(prisma)]);

    // Оба прохода видели запись как due, но задача создана РОВНО одна — сработала
    // идемпотентность outbox (ключ включает слот nextCheckAt).
    const jobs = await prisma.outboxEvent.findMany({ where: { aggregateId: order.id, eventType: AIRWALLEX_VERIFY_EVENT } });
    expect(jobs).toHaveLength(1);
    expect(a.selected).toBeGreaterThan(0);
    expect(b.selected).toBeGreaterThan(0); // второй воркер тоже выбрал её, но дубль не создал
  });

  it("берёт только due-записи и не трогает завершённые", async () => {
    const siteId = await makeSite();
    const due = await makeOrder(siteId);
    const done = await makeOrder(siteId);
    await withPayment(due.id, siteId);
    await withPayment(done.id, siteId);
    await prisma.airwallexPayment.update({ where: { orderId: due.id }, data: { nextCheckAt: new Date(Date.now() - 60_000) } });
    await prisma.airwallexPayment.update({ where: { orderId: done.id }, data: { monitoringActive: false, nextCheckAt: null } });
    await prisma.outboxEvent.deleteMany({ where: { aggregateId: { in: [due.id, done.id] }, eventType: AIRWALLEX_VERIFY_EVENT } });

    await dispatchAirwallexChecks(prisma);

    expect(await prisma.outboxEvent.count({ where: { aggregateId: due.id, eventType: AIRWALLEX_VERIFY_EVENT } })).toBe(1);
    expect(await prisma.outboxEvent.count({ where: { aggregateId: done.id, eventType: AIRWALLEX_VERIFY_EVENT } })).toBe(0);
  });

  it("сайт без мониторинга не попадает в выборку", async () => {
    const offSite = await makeSite(false);
    const order = await makeOrder(offSite);
    await upsertAirwallexPayment(prisma, { orderId: order.id, siteId: offSite, paymentIntentId: "int_off", paymentMethod: "airwallex_card" });
    await prisma.airwallexPayment.update({ where: { orderId: order.id }, data: { nextCheckAt: new Date(Date.now() - 60_000) } });

    await dispatchAirwallexChecks(prisma);
    expect(await prisma.outboxEvent.count({ where: { aggregateId: order.id, eventType: AIRWALLEX_VERIFY_EVENT } })).toBe(0);
  });
});
