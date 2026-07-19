import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { prisma } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { createPrismaDraftPort } from "./draftPort.prisma";
import { handleBurqDraftCreate } from "./draftHandler";
import { applyDeliveryStatusUpdate } from "./statusIngest";
import { handleFloristReassignment } from "./reassignmentService";
import { resolveDeliveryManually } from "./manualResolution";
import { createRetryDeliveryAttempt } from "./retryService";
import { createMockBurqClient, __resetMockBurqStore, __setMockBurqStatus } from "./client";

/**
 * Интеграционные тесты Burq на реальной БД (DATABASE_URL из .env). Требуют применённой
 * миграции 20260719120000_burq_delivery (в т.ч. partial unique index одного текущего attempt).
 * Изолированные фикстуры с уникальным суффиксом, полная очистка после себя. Реальные вызовы
 * Burq НЕ выполняются — mock-клиент. Запускать серийно (--no-file-parallelism).
 */
const suffix = `burq-${Date.now()}`;
let siteId: string;
let floristAId: string;
let floristBId: string;
const userAEmail = `burq-a-${suffix}@test.local`;
const userBEmail = `burq-b-${suffix}@test.local`;
const createdOrderIds: string[] = [];

async function makeOrder(floristId: string | null, deliveryDate = new Date("2026-07-20T00:00:00.000Z")): Promise<string> {
  const order = await prisma.order.create({
    data: {
      orderNumber: `#BQ-${suffix}-${Math.random().toString(36).slice(2, 8)}`,
      site: { connect: { id: siteId } },
      platform: "WOOCOMMERCE",
      source: "Website",
      externalCreatedAt: new Date(),
      deliveryDate,
      deliveryWindow: "12:00 – 16:00",
      senderName: "S",
      senderPhone: "+10000000000",
      recipientName: "Recipient",
      recipientPhone: "+13105550198",
      addressLine: "1 A St",
      city: "Santa Monica",
      zip: "90401",
      itemsTotal: new Prisma.Decimal(100),
      customerTotal: new Prisma.Decimal(115),
      paymentStatus: "PAID",
      orderStatus: "CONFIRMED",
      ...(floristId ? { currentFlorist: { connect: { id: floristId } } } : {}),
    },
    select: { id: true },
  });
  createdOrderIds.push(order.id);
  await prisma.deliveryIntent.create({ data: { orderId: order.id, intentStatus: "SCHEDULED" } });
  return order.id;
}

beforeAll(async () => {
  const site = await prisma.site.create({
    data: { name: `Burq Site ${suffix}`, shortName: "BQT", platform: "WOOCOMMERCE", burqDraftAutoCreateEnabled: true, timezone: "America/Los_Angeles" },
  });
  siteId = site.id;

  const userA = await prisma.user.create({ data: { name: "Burq A", email: userAEmail, role: "FLORIST", passwordHash: "x" } });
  const userB = await prisma.user.create({ data: { name: "Burq B", email: userBEmail, role: "FLORIST", passwordHash: "x" } });
  floristAId = (await prisma.florist.create({ data: { userId: userA.id } })).id;
  floristBId = (await prisma.florist.create({ data: { userId: userB.id } })).id;

  await prisma.floristPickupLocation.create({
    data: { floristId: floristAId, locationName: "Studio A", contactName: "Jane", contactPhone: "+13105551111", addressLine: "200 Market St", city: "Los Angeles", state: "CA", zip: "90013", isActive: true },
  });
  await prisma.floristPickupLocation.create({
    data: { floristId: floristBId, locationName: "Studio B", contactName: "Bob", contactPhone: "+13105552222", addressLine: "9 Sunset Blvd", city: "Los Angeles", state: "CA", zip: "90028", isActive: true },
  });
});

afterAll(async () => {
  await prisma.outboxEvent.deleteMany({ where: { aggregateId: { in: createdOrderIds } } });
  await prisma.order.deleteMany({ where: { siteId } }); // Delivery/Event/Intent каскадно удалятся
  await prisma.floristPickupLocation.deleteMany({ where: { floristId: { in: [floristAId, floristBId] } } });
  await prisma.florist.deleteMany({ where: { id: { in: [floristAId, floristBId] } } });
  await prisma.user.deleteMany({ where: { email: { in: [userAEmail, userBEmail] } } });
  await prisma.site.deleteMany({ where: { id: siteId } });
});

describe("Burq draft create (persistence)", () => {
  it("создаёт Delivery + событие + Intent=DRAFT_CREATED, isCurrentAttempt; checkout_url НЕ в outbox", async () => {
    __resetMockBurqStore();
    const orderId = await makeOrder(floristAId);
    const port = createPrismaDraftPort(prisma);
    const res = await handleBurqDraftCreate({ client: createMockBurqClient(), port }, { orderId, scheduleVersion: 0 });
    expect(res.outcome).toBe("created");

    const delivery = await prisma.delivery.findFirst({ where: { orderId, isCurrentAttempt: true } });
    expect(delivery!.status).toBe("DRAFT_CREATED");
    expect(delivery!.checkoutUrl).toContain("checkout");
    expect(delivery!.floristId).toBe(floristAId);

    const intent = await prisma.deliveryIntent.findUnique({ where: { orderId } });
    expect(intent!.intentStatus).toBe("DRAFT_CREATED");

    // Security: checkout_url не попал ни в один payload outbox для этого заказа.
    const events = await prisma.outboxEvent.findMany({ where: { aggregateId: orderId } });
    for (const e of events) expect(JSON.stringify(e.payload).toLowerCase()).not.toContain("checkout");
  });

  it("partial unique index запрещает второй isCurrentAttempt=true для заказа", async () => {
    const orderId = await makeOrder(floristAId);
    await prisma.delivery.create({ data: { orderId, provider: "BURQ", attemptNumber: 1, isCurrentAttempt: true, status: "DRAFT_PENDING" } });
    await expect(
      prisma.delivery.create({ data: { orderId, provider: "BURQ", attemptNumber: 2, isCurrentAttempt: true, status: "DRAFT_PENDING" } })
    ).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
  });
});

describe("Burq status ingestion (anti-rollback, order status, completed)", () => {
  it("driver_assigned → AWAITING_COURIER; delivered → DELIVERED + publish(orderId,deliveryId)", async () => {
    __resetMockBurqStore();
    const orderId = await makeOrder(floristAId);
    const port = createPrismaDraftPort(prisma);
    await handleBurqDraftCreate({ client: createMockBurqClient(), port }, { orderId, scheduleVersion: 0 });
    const delivery = await prisma.delivery.findFirst({ where: { orderId, isCurrentAttempt: true } });
    const publish = vi.fn().mockResolvedValue(undefined);

    await applyDeliveryStatusUpdate(prisma, publish, { deliveryId: delivery!.id, rawStatus: "driver_assigned", providerEventId: "e1", occurredAt: new Date("2026-07-20T18:00:00Z"), source: "BURQ_WEBHOOK" });
    expect((await prisma.order.findUnique({ where: { id: orderId } }))!.orderStatus).toBe("AWAITING_COURIER");
    expect(publish).not.toHaveBeenCalled();

    await applyDeliveryStatusUpdate(prisma, publish, { deliveryId: delivery!.id, rawStatus: "delivered", providerEventId: "e2", occurredAt: new Date("2026-07-20T19:00:00Z"), source: "BURQ_WEBHOOK" });
    expect((await prisma.order.findUnique({ where: { id: orderId } }))!.orderStatus).toBe("DELIVERED");
    expect(publish).toHaveBeenCalledWith({ orderId, deliveryId: delivery!.id });
  });

  it("attempting reroute → Delivery.PROBLEM, но Order.orderStatus НЕ меняется", async () => {
    __resetMockBurqStore();
    const orderId = await makeOrder(floristAId);
    const port = createPrismaDraftPort(prisma);
    await handleBurqDraftCreate({ client: createMockBurqClient(), port }, { orderId, scheduleVersion: 0 });
    const delivery = await prisma.delivery.findFirst({ where: { orderId, isCurrentAttempt: true } });

    // Приводим заказ в IN_TRANSIT, затем прилетает attempting reroute.
    await applyDeliveryStatusUpdate(prisma, vi.fn(), { deliveryId: delivery!.id, rawStatus: "pickup_complete", providerEventId: "p1", occurredAt: new Date("2026-07-20T18:30:00Z"), source: "BURQ_WEBHOOK" });
    expect((await prisma.order.findUnique({ where: { id: orderId } }))!.orderStatus).toBe("IN_TRANSIT");

    await applyDeliveryStatusUpdate(prisma, vi.fn(), { deliveryId: delivery!.id, rawStatus: "attempting reroute", providerEventId: "r1", occurredAt: new Date("2026-07-20T18:45:00Z"), source: "BURQ_WEBHOOK" });
    expect((await prisma.delivery.findUnique({ where: { id: delivery!.id } }))!.status).toBe("PROBLEM");
    expect((await prisma.order.findUnique({ where: { id: orderId } }))!.orderStatus).toBe("IN_TRANSIT"); // НЕ PROBLEM
  });
});

describe("Manual resolution", () => {
  it("mark_delivered → Delivery+Order DELIVERED, userId сохранён, событие в outbox (key по deliveryId)", async () => {
    __resetMockBurqStore();
    const orderId = await makeOrder(floristAId);
    const port = createPrismaDraftPort(prisma);
    await handleBurqDraftCreate({ client: createMockBurqClient(), port }, { orderId, scheduleVersion: 0 });
    let delivery = await prisma.delivery.findFirst({ where: { orderId, isCurrentAttempt: true } });
    // Заводим проблему.
    await applyDeliveryStatusUpdate(prisma, vi.fn(), { deliveryId: delivery!.id, rawStatus: "attempting reroute", providerEventId: "rr", source: "BURQ_WEBHOOK" });

    const res = await resolveDeliveryManually(prisma, { deliveryId: delivery!.id, decision: "mark_delivered", userId: "user-xyz" });
    expect(res.outcome).toBe("applied");
    delivery = await prisma.delivery.findFirst({ where: { orderId, isCurrentAttempt: true } });
    expect(delivery!.status).toBe("DELIVERED");
    expect(delivery!.resolvedByUserId).toBe("user-xyz");
    expect((await prisma.order.findUnique({ where: { id: orderId } }))!.orderStatus).toBe("DELIVERED");

    const completed = await prisma.outboxEvent.findUnique({ where: { idempotencyKey: `order.delivery.completed:${delivery!.id}` } });
    expect(completed).toBeTruthy();
    expect(completed!.eventType).toBe("order.delivery.completed");
  });

  it("mark_cancelled → Delivery CANCELLED, Order/Payment не меняются, completed НЕ публикуется", async () => {
    __resetMockBurqStore();
    const orderId = await makeOrder(floristAId);
    const port = createPrismaDraftPort(prisma);
    await handleBurqDraftCreate({ client: createMockBurqClient(), port }, { orderId, scheduleVersion: 0 });
    const delivery = await prisma.delivery.findFirst({ where: { orderId, isCurrentAttempt: true } });
    const before = await prisma.order.findUnique({ where: { id: orderId } });

    await resolveDeliveryManually(prisma, { deliveryId: delivery!.id, decision: "mark_cancelled", userId: "user-xyz" });
    const after = await prisma.order.findUnique({ where: { id: orderId } });
    expect((await prisma.delivery.findUnique({ where: { id: delivery!.id } }))!.status).toBe("CANCELLED");
    expect(after!.orderStatus).toBe(before!.orderStatus); // не изменился
    expect(after!.paymentStatus).toBe(before!.paymentStatus);
    const completed = await prisma.outboxEvent.findUnique({ where: { idempotencyKey: `order.delivery.completed:${delivery!.id}` } });
    expect(completed).toBeNull();
  });
});

describe("Retry delivery attempt (provider_canceled → новая попытка)", () => {
  async function draftedThenCancelledWithCost() {
    __resetMockBurqStore();
    const orderId = await makeOrder(floristAId);
    const port = createPrismaDraftPort(prisma);
    await handleBurqDraftCreate({ client: createMockBurqClient(), port }, { orderId, scheduleVersion: 0 });
    const del = await prisma.delivery.findFirst({ where: { orderId, isCurrentAttempt: true } });
    // Стоимость на старой попытке, затем provider_canceled.
    await applyDeliveryStatusUpdate(prisma, vi.fn(), { deliveryId: del!.id, providerEventId: "e1", occurredAt: new Date("2026-07-20T18:00:00Z"), source: "BURQ_WEBHOOK", rawStatus: "enroute_pickup", provider: "Uber", providerId: "dsp_x", totalAmountDueCents: 1550, currency: "USD" });
    await applyDeliveryStatusUpdate(prisma, vi.fn(), { deliveryId: del!.id, providerEventId: "e2", occurredAt: new Date("2026-07-20T18:30:00Z"), source: "BURQ_WEBHOOK", rawStatus: "provider_canceled", provider: "Uber", providerId: "dsp_x" });
    return { orderId, oldDeliveryId: del!.id };
  }

  it("provider_canceled → старая Delivery CANCELLED, Order.orderStatus не меняется", async () => {
    __resetMockBurqStore();
    const orderId = await makeOrder(floristAId);
    const port = createPrismaDraftPort(prisma);
    await handleBurqDraftCreate({ client: createMockBurqClient(), port }, { orderId, scheduleVersion: 0 });
    const del = await prisma.delivery.findFirst({ where: { orderId, isCurrentAttempt: true } });
    await applyDeliveryStatusUpdate(prisma, vi.fn(), { deliveryId: del!.id, providerEventId: "p1", occurredAt: new Date(), source: "BURQ_WEBHOOK", rawStatus: "provider_canceled" });
    const before = await prisma.order.findUnique({ where: { id: orderId } });
    expect((await prisma.delivery.findUnique({ where: { id: del!.id } }))!.status).toBe("CANCELLED");
    expect(before!.orderStatus).not.toBe("CANCELLED"); // заказ не отменён
  });

  it("ретрай: attempt+1, старая сохранена (false, стоимость в ней), новая current (стоимость null), supersedes, актуальный флорист, deliveryActualCost=0", async () => {
    const { orderId, oldDeliveryId } = await draftedThenCancelledWithCost();
    const res = await createRetryDeliveryAttempt(prisma, orderId);
    expect(res.outcome).toBe("created");

    const all = await prisma.delivery.findMany({ where: { orderId }, orderBy: { attemptNumber: "asc" } });
    expect(all).toHaveLength(2);
    const [a1, a2] = all;
    expect(a1.id).toBe(oldDeliveryId);
    expect(a1.isCurrentAttempt).toBe(false); // старая → false
    expect(a1.status).toBe("CANCELLED"); // статус старой не меняем
    expect(Number(a1.finalCost)).toBe(15.5); // стоимость сохранена в СТАРОЙ Delivery (item 17)
    expect(a2.attemptNumber).toBe(2);
    expect(a2.isCurrentAttempt).toBe(true);
    expect(a2.finalCost).toBeNull(); // новая — стоимость null (item 9)
    expect(a2.floristId).toBe(floristAId); // актуальный флорист/pickup (item 15)
    expect(a2.supersedesDeliveryId).toBe(a1.id);
    expect(a1.supersededByDeliveryId).toBe(a2.id);
    expect(Number((await prisma.order.findUnique({ where: { id: orderId } }))!.deliveryActualCost)).toBe(0); // сброшена
  });

  it("двойной клик не создаёт дубль (вторая — already_active)", async () => {
    const { orderId } = await draftedThenCancelledWithCost();
    const r1 = await createRetryDeliveryAttempt(prisma, orderId);
    expect(r1.outcome).toBe("created");
    const r2 = await createRetryDeliveryAttempt(prisma, orderId);
    expect(r2.outcome).toBe("already_active");
    expect(await prisma.delivery.count({ where: { orderId } })).toBe(2); // не 3
  });

  it("защита от гонки: две текущие попытки невозможны (claim-lock + partial unique index)", async () => {
    // Истинную конкуренцию pglite на одном соединении не воспроизводит; проверяем гарант БД —
    // partial unique index (в реальном Postgres он же + row-lock claim блокируют вторую текущую).
    const { orderId } = await draftedThenCancelledWithCost();
    const r1 = await createRetryDeliveryAttempt(prisma, orderId);
    expect(r1.outcome).toBe("created");
    expect(await prisma.delivery.count({ where: { orderId, isCurrentAttempt: true } })).toBe(1);
    // Прямая вставка второй isCurrentAttempt=true для этого заказа → partial unique index блокирует.
    await expect(
      prisma.delivery.create({ data: { orderId, provider: "BURQ", attemptNumber: 99, isCurrentAttempt: true, status: "DRAFT_PENDING" } })
    ).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
  });

  it("заказ DELIVERED → ретрай недоступен (not_retryable)", async () => {
    const { orderId } = await draftedThenCancelledWithCost();
    await prisma.order.update({ where: { id: orderId }, data: { orderStatus: "DELIVERED" } });
    const res = await createRetryDeliveryAttempt(prisma, orderId);
    expect(res).toEqual({ outcome: "not_retryable", reason: "order_terminal" });
  });

  it("заказ CANCELLED → ретрай недоступен (not_retryable)", async () => {
    const { orderId } = await draftedThenCancelledWithCost();
    await prisma.order.update({ where: { id: orderId }, data: { orderStatus: "CANCELLED" } });
    const res = await createRetryDeliveryAttempt(prisma, orderId);
    expect(res).toEqual({ outcome: "not_retryable", reason: "order_terminal" });
  });
});

describe("Florist reassignment", () => {
  it("uninitiated request → DELETE + новая attempt под florist B, старая CANCELLED/FLORIST_REASSIGNED, один current", async () => {
    __resetMockBurqStore();
    const orderId = await makeOrder(floristAId);
    const port = createPrismaDraftPort(prisma);
    await handleBurqDraftCreate({ client: createMockBurqClient(), port }, { orderId, scheduleVersion: 0 });
    const first = await prisma.delivery.findFirst({ where: { orderId, isCurrentAttempt: true } });

    // Переназначаем на florist B.
    await prisma.order.update({ where: { id: orderId }, data: { currentFloristId: floristBId } });
    const res = await handleFloristReassignment(prisma, orderId);
    expect(res.outcome).toBe("recreated");

    const all = await prisma.delivery.findMany({ where: { orderId }, orderBy: { attemptNumber: "asc" } });
    const current = all.filter((d) => d.isCurrentAttempt);
    expect(current).toHaveLength(1);
    expect(current[0].attemptNumber).toBe(2);
    expect(current[0].floristId).toBe(floristBId);
    expect(current[0].supersedesDeliveryId).toBe(first!.id);

    const old = all.find((d) => d.id === first!.id)!;
    expect(old.isCurrentAttempt).toBe(false);
    expect(old.status).toBe("CANCELLED");
    expect(old.cancellationReason).toBe("FLORIST_REASSIGNED");
    expect(old.supersededByDeliveryId).toBe(current[0].id);
  });

  it("уже инициированный draft → FLAG_PROBLEM, без DELETE, без второй attempt", async () => {
    __resetMockBurqStore();
    const orderId = await makeOrder(floristAId);
    const port = createPrismaDraftPort(prisma);
    await handleBurqDraftCreate({ client: createMockBurqClient(), port }, { orderId, scheduleVersion: 0 });
    const first = await prisma.delivery.findFirst({ where: { orderId, isCurrentAttempt: true } });
    // Симулируем ИНИЦИИРОВАННЫЙ заказ в Burq (курьер назначен) — reassignment смотрит live-статус.
    __setMockBurqStatus(first!.externalDeliveryId!, "driver_assigned");
    await prisma.delivery.update({ where: { id: first!.id }, data: { status: "COURIER_ASSIGNED" } });

    const orderBefore = await prisma.order.findUnique({ where: { id: orderId } });
    await prisma.order.update({ where: { id: orderId }, data: { currentFloristId: floristBId } });
    const res = await handleFloristReassignment(prisma, orderId);
    expect(res.outcome).toBe("flagged_problem");

    const all = await prisma.delivery.findMany({ where: { orderId } });
    expect(all).toHaveLength(1); // второй attempt не создан
    expect(all[0].status).toBe("PROBLEM");
    // Проблема доставки НЕ меняет производственный статус заказа.
    expect((await prisma.order.findUnique({ where: { id: orderId } }))!.orderStatus).toBe(orderBefore!.orderStatus);
  });
});

describe("Uber cost capture (Path A)", () => {
  async function makeDraftedOrder() {
    __resetMockBurqStore();
    const orderId = await makeOrder(floristAId);
    const port = createPrismaDraftPort(prisma);
    await handleBurqDraftCreate({ client: createMockBurqClient(), port }, { orderId, scheduleVersion: 0 });
    const delivery = await prisma.delivery.findFirst({ where: { orderId, isCurrentAttempt: true } });
    return { orderId, deliveryId: delivery!.id };
  }
  const uber = (over: Record<string, unknown> = {}) => ({
    source: "BURQ_WEBHOOK" as const, rawStatus: "driver_assigned", provider: "uber", providerId: "prov_uber_1",
    totalAmountDueCents: 1550, currency: "USD", quoteId: "q1", ...over,
  });

  it("Uber → Delivery.finalCost + Order.deliveryActualCost + profit; OrderStatus по статусу, Payment не меняется", async () => {
    const { orderId, deliveryId } = await makeDraftedOrder();
    const before = await prisma.order.findUnique({ where: { id: orderId } });
    const r = await applyDeliveryStatusUpdate(prisma, vi.fn(), { deliveryId, providerEventId: "e1", occurredAt: new Date("2026-07-20T18:00:00Z"), ...uber() });
    expect(r.outcome).toBe("applied");
    const del = await prisma.delivery.findUnique({ where: { id: deliveryId } });
    expect(Number(del!.finalCost)).toBe(15.5);
    expect(del!.costSource).toBe("BURQ_FINAL");
    expect(del!.providerName).toBe("uber");
    expect(del!.providerExternalId).toBe("prov_uber_1");
    const ord = await prisma.order.findUnique({ where: { id: orderId } });
    expect(Number(ord!.deliveryActualCost)).toBe(15.5);
    expect(Number(ord!.estimatedProfit)).toBe(Number(ord!.itemsTotal) - Number(ord!.floristTotal) - 15.5);
    expect(ord!.orderStatus).toBe("AWAITING_COURIER"); // из маппинга driver_assigned
    expect(ord!.paymentStatus).toBe(before!.paymentStatus); // Payment не меняется
  });

  it("trackingUrl из webhook синхронизируется в Order.trackingUrl (карточка «Статус доставки»)", async () => {
    const { orderId, deliveryId } = await makeDraftedOrder();
    const url = "https://tracking.burqup.com/orders/track/o_test123";
    await applyDeliveryStatusUpdate(prisma, vi.fn(), { deliveryId, providerEventId: "t1", occurredAt: new Date(), ...uber(), trackingUrl: url });
    expect((await prisma.delivery.findUnique({ where: { id: deliveryId } }))!.trackingUrl).toBe(url);
    expect((await prisma.order.findUnique({ where: { id: orderId } }))!.trackingUrl).toBe(url);
  });

  it("матчинг Delivery по external_order_ref (webhook path) — находит и пишет стоимость", async () => {
    const { orderId } = await makeDraftedOrder();
    const del = await prisma.delivery.findFirst({ where: { orderId, isCurrentAttempt: true }, select: { externalOrderRef: true } });
    expect(del!.externalOrderRef).toBeTruthy();
    const r = await applyDeliveryStatusUpdate(prisma, vi.fn(), { externalOrderRef: del!.externalOrderRef, providerEventId: "e1", occurredAt: new Date(), ...uber() });
    expect(r.outcome).toBe("applied");
    expect(Number((await prisma.order.findUnique({ where: { id: orderId } }))!.deliveryActualCost)).toBe(15.5);
  });

  it("другой провайдер → стоимость игнорируется (deliveryActualCost не меняется)", async () => {
    const { orderId, deliveryId } = await makeDraftedOrder();
    await applyDeliveryStatusUpdate(prisma, vi.fn(), { deliveryId, providerEventId: "e1", ...uber({ provider: "doordash" }) });
    expect(Number((await prisma.order.findUnique({ where: { id: orderId } }))!.deliveryActualCost)).toBe(0);
    expect((await prisma.delivery.findUnique({ where: { id: deliveryId } }))!.finalCost).toBeNull();
  });

  it("нет суммы → старое значение не обнуляется", async () => {
    const { orderId, deliveryId } = await makeDraftedOrder();
    await applyDeliveryStatusUpdate(prisma, vi.fn(), { deliveryId, providerEventId: "e1", occurredAt: new Date("2026-07-20T18:00:00Z"), ...uber() });
    await applyDeliveryStatusUpdate(prisma, vi.fn(), { deliveryId, providerEventId: "e2", occurredAt: new Date("2026-07-20T18:30:00Z"), ...uber({ totalAmountDueCents: null, currency: null }) });
    expect(Number((await prisma.order.findUnique({ where: { id: orderId } }))!.deliveryActualCost)).toBe(15.5); // сохранилось
  });

  it("более новый webhook обновляет цену; stale — не откатывает", async () => {
    const { orderId, deliveryId } = await makeDraftedOrder();
    await applyDeliveryStatusUpdate(prisma, vi.fn(), { deliveryId, providerEventId: "e1", occurredAt: new Date("2026-07-20T18:00:00Z"), ...uber({ totalAmountDueCents: 1550 }) });
    await applyDeliveryStatusUpdate(prisma, vi.fn(), { deliveryId, providerEventId: "e2", occurredAt: new Date("2026-07-20T19:00:00Z"), ...uber({ totalAmountDueCents: 1800 }) });
    expect(Number((await prisma.order.findUnique({ where: { id: orderId } }))!.deliveryActualCost)).toBe(18);
    // stale (старее finalCostUpdatedAt) не откатывает
    await applyDeliveryStatusUpdate(prisma, vi.fn(), { deliveryId, providerEventId: "e3", occurredAt: new Date("2026-07-20T10:00:00Z"), ...uber({ totalAmountDueCents: 500 }) });
    expect(Number((await prisma.order.findUnique({ where: { id: orderId } }))!.deliveryActualCost)).toBe(18);
  });

  it("повторный webhook (тот же providerEventId) идемпотентен", async () => {
    const { orderId, deliveryId } = await makeDraftedOrder();
    await applyDeliveryStatusUpdate(prisma, vi.fn(), { deliveryId, providerEventId: "dup", ...uber() });
    const r2 = await applyDeliveryStatusUpdate(prisma, vi.fn(), { deliveryId, providerEventId: "dup", ...uber({ totalAmountDueCents: 9999 }) });
    expect(r2.outcome).toBe("duplicate");
    expect(Number((await prisma.order.findUnique({ where: { id: orderId } }))!.deliveryActualCost)).toBe(15.5); // не перезаписано дублем
  });

  it("delivered продолжает работать (Order DELIVERED + publish) и с ценой", async () => {
    const { orderId, deliveryId } = await makeDraftedOrder();
    const publish = vi.fn().mockResolvedValue(undefined);
    await applyDeliveryStatusUpdate(prisma, publish, { deliveryId, providerEventId: "d1", occurredAt: new Date("2026-07-20T20:00:00Z"), ...uber({ rawStatus: "delivered", totalAmountDueCents: 1700 }) });
    const ord = await prisma.order.findUnique({ where: { id: orderId } });
    expect(ord!.orderStatus).toBe("DELIVERED");
    expect(Number(ord!.deliveryActualCost)).toBe(17);
    expect(publish).toHaveBeenCalledWith({ orderId, deliveryId });
  });

  it("событие в истории не содержит PII/стоимости payload (только нормализованные поля)", async () => {
    const { deliveryId } = await makeDraftedOrder();
    await applyDeliveryStatusUpdate(prisma, vi.fn(), { deliveryId, providerEventId: "e1", ...uber() });
    const events = await prisma.deliveryStatusEvent.findMany({ where: { deliveryId } });
    const dump = JSON.stringify(events);
    expect(dump).not.toContain("Recipient"); // имя получателя
    expect(dump).not.toContain("1 A St"); // адрес
    expect(dump).not.toContain("+13105550198"); // телефон
  });
});
