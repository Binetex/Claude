import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import type { OutboxRecord } from "@/outbox/types";
import type { QuoClient } from "@/integrations/quo/client";
import { quoErrorFromStatus } from "@/integrations/quo/errors";
import { buildAutomationTriggerHandler, buildAutomationSendHandler } from "./handlers";
import { createSmsChannelSender } from "./channels/sms";
import { setAutomationsGloballyDisabled } from "./settings";

/**
 * Интеграция Automation Engine на реальной БД (throwaway prisma dev). Прогоняем handler'ы напрямую
 * (worker лишь диспетчеризует по eventType), отправка идёт через SMS-ChannelSender с фейковым QUO.
 * Покрываем инженерные сценарии ТЗ (test-send «без production-job» — в automations-units.test.ts).
 */

const suffix = `smsit-${Date.now()}`;
const createdSiteIds: string[] = [];
const createdOrderIds: string[] = [];

let sendOk = true; // переключатель поведения фейкового клиента (успех/временный сбой 500)
let sentCount = 0;
// Частичный мок: реально используется только sendMessage (остальные методы QuoClient не нужны).
const fakeClient = {
  async sendMessage(input: { content: string; from: string; to: string[] }) {
    if (!sendOk) throw quoErrorFromStatus(500);
    return { id: `AC-${suffix}-${sentCount++}`, status: "sent", conversationId: `CN-${suffix}`, from: input.from, to: input.to };
  },
} as unknown as QuoClient;

const triggerHandler = buildAutomationTriggerHandler(prisma);
const sendHandler = buildAutomationSendHandler(prisma, { channels: { SMS: createSmsChannelSender(() => fakeClient) } });

function rec(payload: unknown, attempts = 0, maxAttempts = 8): OutboxRecord {
  return {
    id: "evt", eventType: "x", aggregateType: "order", aggregateId: "o", payload,
    idempotencyKey: `k-${Math.random()}`, status: "PROCESSING", attempts, maxAttempts,
    availableAt: new Date(), lockedAt: new Date(), lockedBy: "test", processedAt: null,
    lastError: null, createdAt: new Date(), updatedAt: new Date(),
  };
}

async function makeSite(overrides: { reviewUrl?: string | null; quoEnabled?: boolean } = {}) {
  const site = await prisma.site.create({
    data: {
      name: `SMS Site ${suffix}-${createdSiteIds.length}`,
      shortName: "SMS",
      platform: "WOOCOMMERCE",
      quoEnabled: overrides.quoEnabled ?? true,
      quoPhoneNumberId: `PN-${suffix}-${createdSiteIds.length}`,
      quoPhoneNumber: "+15550000000",
      reviewUrl: overrides.reviewUrl ?? null,
    },
  });
  createdSiteIds.push(site.id);
  return site;
}

async function makeOrder(siteId: string, overrides: Partial<Prisma.OrderCreateInput> = {}) {
  const order = await prisma.order.create({
    data: {
      orderNumber: `#SMS-${suffix}-${Math.random().toString(36).slice(2, 8)}`,
      site: { connect: { id: siteId } },
      platform: "WOOCOMMERCE",
      source: "Website",
      externalCreatedAt: new Date(),
      deliveryDate: new Date(),
      deliveryWindow: "12:00 – 16:00",
      senderName: "Anna",
      senderPhone: "+15551112222",
      recipientName: "Maria",
      recipientPhone: "+15553334444",
      addressLine: "1 Main St",
      city: "Portland",
      zip: "00000",
      itemsTotal: new Prisma.Decimal(100),
      customerTotal: new Prisma.Decimal(115),
      paymentStatus: "PAID",
      orderStatus: "CONFIRMED",
      ...overrides,
    },
  });
  createdOrderIds.push(order.id);
  return order;
}

function makeAutomation(siteIds: string | string[], overrides: Partial<Prisma.AutomationUncheckedCreateInput> = {}) {
  const ids = Array.isArray(siteIds) ? siteIds : [siteIds];
  return prisma.automation.create({
    data: {
      sites: { create: ids.map((siteId) => ({ siteId })) },
      name: `auto ${suffix}`,
      active: true,
      triggerType: "ORDER_CREATED",
      audience: "CUSTOMER",
      delayAmount: 0,
      delayUnit: "IMMEDIATE",
      template: "Hi {{sender_name}}",
      ...overrides,
    },
  });
}

async function fireTrigger(order: { id: string; siteId: string }, triggerType: string, occurrenceKey?: string) {
  await triggerHandler(rec({ orderId: order.id, siteId: order.siteId, triggerType, occurrenceKey: occurrenceKey ?? order.id }));
}

function jobsFor(automationId: string, orderId: string) {
  return prisma.automationJob.findMany({ where: { automationId, orderId } });
}

beforeAll(async () => { sendOk = true; await setAutomationsGloballyDisabled(prisma, false, null); });

afterAll(async () => {
  await prisma.automationExecutionLog.deleteMany({});
  await prisma.automationJob.deleteMany({});
  await prisma.orderCommunication.deleteMany({ where: { orderId: { in: createdOrderIds } } });
  await prisma.automation.deleteMany({});
  await prisma.automationSettings.deleteMany({});
  await prisma.outboxEvent.deleteMany({ where: { eventType: { startsWith: "sms." } } });
  await prisma.order.deleteMany({ where: { id: { in: createdOrderIds } } });
  await prisma.site.deleteMany({ where: { id: { in: createdSiteIds } } });
  await prisma.$disconnect();
});

describe("SMS engine — trigger → job", () => {
  it("1. ORDER_CREATED создаёт запланированный job", async () => {
    const site = await makeSite();
    const auto = await makeAutomation(site.id);
    const order = await makeOrder(site.id);
    await fireTrigger(order, "ORDER_CREATED");
    const jobs = await jobsFor(auto.id, order.id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ status: "SCHEDULED", recipientType: "CUSTOMER" });
  });

  it("3. ORDER_DELIVERED с задержкой ставит job в будущее (delay работает)", async () => {
    const site = await makeSite();
    const auto = await makeAutomation(site.id, { triggerType: "ORDER_DELIVERED", delayAmount: 30, delayUnit: "MINUTE" });
    const order = await makeOrder(site.id);
    const before = Date.now();
    await fireTrigger(order, "ORDER_DELIVERED", "delivery-1");
    const jobs = await jobsFor(auto.id, order.id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].scheduledAt.getTime()).toBeGreaterThan(before + 29 * 60_000);
  });

  it("4. BOTH с одинаковым номером → один job-ЗАКАЗЧИК", async () => {
    const site = await makeSite();
    const auto = await makeAutomation(site.id, { audience: "BOTH" });
    const order = await makeOrder(site.id, { senderPhone: "+15551112222", recipientPhone: "+1 (555) 111-2222" });
    await fireTrigger(order, "ORDER_CREATED");
    const jobs = await jobsFor(auto.id, order.id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].recipientType).toBe("CUSTOMER");
  });

  it("4b. RECIPIENT, но номер совпадает с заказчиком → один job-ЗАКАЗЧИК", async () => {
    const site = await makeSite();
    const auto = await makeAutomation(site.id, { audience: "RECIPIENT" });
    const order = await makeOrder(site.id, { senderPhone: "+15551112222", recipientPhone: "+1 (555) 111-2222" });
    await fireTrigger(order, "ORDER_CREATED");
    const jobs = await jobsFor(auto.id, order.id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].recipientType).toBe("CUSTOMER"); // не RECIPIENT
  });

  it("5. Повторный trigger не создаёт дубль", async () => {
    const site = await makeSite();
    const auto = await makeAutomation(site.id);
    const order = await makeOrder(site.id);
    await fireTrigger(order, "ORDER_CREATED");
    await fireTrigger(order, "ORDER_CREATED");
    expect(await jobsFor(auto.id, order.id)).toHaveLength(1);
  });

  it("6. Отменённый заказ → job не создаётся", async () => {
    const site = await makeSite();
    const auto = await makeAutomation(site.id);
    const order = await makeOrder(site.id, { orderStatus: "CANCELLED" });
    await fireTrigger(order, "ORDER_CREATED");
    expect(await jobsFor(auto.id, order.id)).toHaveLength(0);
  });

  it("7. Выключенная автоматизация → job не создаётся", async () => {
    const site = await makeSite();
    const auto = await makeAutomation(site.id, { active: false });
    const order = await makeOrder(site.id);
    await fireTrigger(order, "ORDER_CREATED");
    expect(await jobsFor(auto.id, order.id)).toHaveLength(0);
  });

  it("16. Автоматизация одного Site не срабатывает от события другого Site", async () => {
    const siteA = await makeSite();
    const siteB = await makeSite();
    const autoA = await makeAutomation(siteA.id);
    const orderB = await makeOrder(siteB.id);
    await fireTrigger(orderB, "ORDER_CREATED"); // событие Site B
    expect(await jobsFor(autoA.id, orderB.id)).toHaveLength(0);
  });

  it("16a. Одно правило на несколько Site срабатывает от события каждого из них", async () => {
    const siteA = await makeSite();
    const siteB = await makeSite();
    const siteC = await makeSite();
    const auto = await makeAutomation([siteA.id, siteB.id]);

    const orderA = await makeOrder(siteA.id);
    const orderB = await makeOrder(siteB.id);
    const orderC = await makeOrder(siteC.id); // Site вне правила
    await fireTrigger(orderA, "ORDER_CREATED");
    await fireTrigger(orderB, "ORDER_CREATED");
    await fireTrigger(orderC, "ORDER_CREATED");

    expect(await jobsFor(auto.id, orderA.id)).toHaveLength(1);
    expect(await jobsFor(auto.id, orderB.id)).toHaveLength(1);
    expect(await jobsFor(auto.id, orderC.id)).toHaveLength(0);
  });
});

describe("новые триггеры: доставка сегодня и состояния оплаты", () => {
  it("DELIVERY_TODAY создаёт job для заказа с доставкой СЕГОДНЯ", async () => {
    const site = await makeSite();
    const auto = await makeAutomation(site.id, { triggerType: "DELIVERY_TODAY" });
    const order = await makeOrder(site.id, { deliveryDate: new Date() });
    await fireTrigger(order, "DELIVERY_TODAY", `${order.id}:today`);
    expect(await jobsFor(auto.id, order.id)).toHaveLength(1);
  });

  it("DELIVERY_TODAY НЕ создаёт job, если дату перенесли (устаревшая задача)", async () => {
    const site = await makeSite();
    const auto = await makeAutomation(site.id, { triggerType: "DELIVERY_TODAY" });
    // Задача была поставлена на сегодня, но дату сдвинули на неделю вперёд.
    const order = await makeOrder(site.id, { deliveryDate: new Date(Date.now() + 7 * 864e5) });
    await fireTrigger(order, "DELIVERY_TODAY", `${order.id}:stale`);
    expect(await jobsFor(auto.id, order.id)).toHaveLength(0);
  });

  it("ORDER_REFUNDED срабатывает, несмотря на дефолтное исключение возвратов", async () => {
    const site = await makeSite();
    const auto = await makeAutomation(site.id, { triggerType: "ORDER_REFUNDED" });
    const order = await makeOrder(site.id, { paymentStatus: "REFUNDED" });
    await fireTrigger(order, "ORDER_REFUNDED", `${order.id}:ORDER_REFUNDED`);
    // Без снятия excludeCancelledRefunded правило молча не сработало бы никогда.
    expect(await jobsFor(auto.id, order.id)).toHaveLength(1);
  });

  it("обычное правило по-прежнему отсекает возвращённый заказ", async () => {
    const site = await makeSite();
    const auto = await makeAutomation(site.id, { triggerType: "ORDER_CREATED" });
    const order = await makeOrder(site.id, { paymentStatus: "REFUNDED" });
    await fireTrigger(order, "ORDER_CREATED");
    expect(await jobsFor(auto.id, order.id)).toHaveLength(0);
  });
});

describe("SMS engine — send job", () => {
  async function triggerAndGetJob(siteId: string, order: { id: string; siteId: string }, autoOverrides: Partial<Prisma.AutomationUncheckedCreateInput>, triggerType = "ORDER_CREATED") {
    const auto = await makeAutomation(siteId, autoOverrides);
    await fireTrigger(order, triggerType);
    const job = (await jobsFor(auto.id, order.id))[0];
    return { auto, job };
  }

  it("12/11. Успешная отправка → OrderCommunication с номером своего Site; job SENT", async () => {
    sendOk = true;
    const site = await makeSite();
    const order = await makeOrder(site.id);
    const { job } = await triggerAndGetJob(site.id, order, { template: "Hi {{sender_name}}" });
    await sendHandler(rec({ jobId: job.id, orderId: order.id }));
    const updated = await prisma.automationJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(updated.status).toBe("SENT");
    expect(updated.communicationId).toBeTruthy();
    const comm = await prisma.orderCommunication.findUniqueOrThrow({ where: { id: updated.communicationId! } });
    expect(comm.type).toBe("SMS");
    expect(comm.direction).toBe("OUTBOUND");
    expect(comm.providerPhoneNumberId).toBe(site.quoPhoneNumberId); // номер своего Site
  });

  it("9/10. Шаблон рендерит переменные; отсутствующая не становится 'undefined'", async () => {
    sendOk = true;
    const site = await makeSite();
    const order = await makeOrder(site.id, { senderName: "Anna" });
    const { job } = await triggerAndGetJob(site.id, order, { template: "Hi {{sender_name}} {{nonexistent}}" });
    await sendHandler(rec({ jobId: job.id, orderId: order.id }));
    const updated = await prisma.automationJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(updated.renderedTextSnapshot).toBe("Hi Anna");
    expect(updated.renderedTextSnapshot).not.toContain("undefined");
    const comm = await prisma.orderCommunication.findUniqueOrThrow({ where: { id: updated.communicationId! } });
    expect(comm.messageText).toBe("Hi Anna");
  });

  it("2. TRACKING_LINK_AVAILABLE не отправляет без реального tracking_url (SKIP), и отправляет с ним", async () => {
    sendOk = true;
    const site = await makeSite();
    // без трека → SKIP
    const orderNo = await makeOrder(site.id, { trackingUrl: null });
    const a = await triggerAndGetJob(site.id, orderNo, { triggerType: "TRACKING_LINK_AVAILABLE", template: "Track {{tracking_url}}" }, "TRACKING_LINK_AVAILABLE");
    await sendHandler(rec({ jobId: a.job.id, orderId: orderNo.id }));
    expect((await prisma.automationJob.findUniqueOrThrow({ where: { id: a.job.id } })).status).toBe("SKIPPED");
    // с треком → SENT
    const orderYes = await makeOrder(site.id, { trackingUrl: "https://track.example/x" });
    const b = await triggerAndGetJob(site.id, orderYes, { triggerType: "TRACKING_LINK_AVAILABLE", template: "Track {{tracking_url}}" }, "TRACKING_LINK_AVAILABLE");
    await sendHandler(rec({ jobId: b.job.id, orderId: orderYes.id }));
    expect((await prisma.automationJob.findUniqueOrThrow({ where: { id: b.job.id } })).status).toBe("SENT");
  });

  it("6b. Заказ отменён к моменту отправки → SKIP (повторная проверка условий)", async () => {
    sendOk = true;
    const site = await makeSite();
    const order = await makeOrder(site.id);
    const { job } = await triggerAndGetJob(site.id, order, {});
    await prisma.order.update({ where: { id: order.id }, data: { orderStatus: "CANCELLED" } });
    await sendHandler(rec({ jobId: job.id, orderId: order.id }));
    const updated = await prisma.automationJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(updated.status).toBe("SKIPPED");
    expect(updated.lastErrorSafe).toBe("order_cancelled_or_refunded");
  });

  it("6c. Магазин отвязан от правила к моменту отправки → SKIP automation_not_enabled_for_site", async () => {
    sendOk = true;
    const site = await makeSite();
    const order = await makeOrder(site.id);
    const { auto, job } = await triggerAndGetJob(site.id, order, {});
    await prisma.automationSite.delete({ where: { automationId_siteId: { automationId: auto.id, siteId: site.id } } });
    await sendHandler(rec({ jobId: job.id, orderId: order.id }));
    const updated = await prisma.automationJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(updated.status).toBe("SKIPPED");
    expect(updated.lastErrorSafe).toBe("automation_not_enabled_for_site");
  });

  it("8. Выключённый QUO у Site → SKIP site_quo_disabled", async () => {
    sendOk = true;
    const site = await makeSite();
    const order = await makeOrder(site.id);
    const { job } = await triggerAndGetJob(site.id, order, {});
    await prisma.site.update({ where: { id: site.id }, data: { quoEnabled: false } });
    await sendHandler(rec({ jobId: job.id, orderId: order.id }));
    expect((await prisma.automationJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("SKIPPED");
  });

  it("17. review_url берётся из своего Site; без неё review-правило SKIP", async () => {
    sendOk = true;
    const siteWith = await makeSite({ reviewUrl: "https://rev-correct" });
    const orderW = await makeOrder(siteWith.id);
    const w = await triggerAndGetJob(siteWith.id, orderW, { template: "Review {{review_url}}" });
    await sendHandler(rec({ jobId: w.job.id, orderId: orderW.id }));
    const commW = await prisma.orderCommunication.findFirstOrThrow({ where: { orderId: orderW.id } });
    expect(commW.messageText).toContain("https://rev-correct");

    const siteNo = await makeSite({ reviewUrl: null });
    const orderN = await makeOrder(siteNo.id);
    const n = await triggerAndGetJob(siteNo.id, orderN, { template: "Review {{review_url}}" });
    await sendHandler(rec({ jobId: n.job.id, orderId: orderN.id }));
    expect((await prisma.automationJob.findUniqueOrThrow({ where: { id: n.job.id } })).status).toBe("SKIPPED");
  });

  it("13. Временный сбой отправки → retry (job остаётся SCHEDULED, throw), затем терминальный FAILED", async () => {
    const site = await makeSite();
    const order = await makeOrder(site.id);
    const { job } = await triggerAndGetJob(site.id, order, {});
    sendOk = false; // QUO 500
    await expect(sendHandler(rec({ jobId: job.id, orderId: order.id }, 0, 8))).rejects.toThrow();
    let updated = await prisma.automationJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(updated.status).toBe("SCHEDULED"); // остаётся для повтора
    expect(updated.lastErrorSafe).toBe("quo_server");
    // последняя попытка → терминальный FAILED без throw
    await sendHandler(rec({ jobId: job.id, orderId: order.id }, 8, 8));
    updated = await prisma.automationJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(updated.status).toBe("FAILED");
    sendOk = true;
  });

  it("14. Изменение шаблона не меняет уже отправленное сообщение", async () => {
    sendOk = true;
    const site = await makeSite();
    const order = await makeOrder(site.id, { senderName: "Anna" });
    const { auto, job } = await triggerAndGetJob(site.id, order, { template: "Hi {{sender_name}}" });
    await sendHandler(rec({ jobId: job.id, orderId: order.id }));
    const snapshot = (await prisma.automationJob.findUniqueOrThrow({ where: { id: job.id } })).renderedTextSnapshot;
    expect(snapshot).toBe("Hi Anna");
    await prisma.automation.update({ where: { id: auto.id }, data: { template: "Totally different {{sender_name}}" } });
    const after = await prisma.automationJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(after.renderedTextSnapshot).toBe("Hi Anna"); // снимок не меняется
  });

  it("5b. Повторная доставка sms.send идемпотентна (уже SENT → без второй отправки)", async () => {
    sendOk = true;
    const site = await makeSite();
    const order = await makeOrder(site.id);
    const { job } = await triggerAndGetJob(site.id, order, {});
    await sendHandler(rec({ jobId: job.id, orderId: order.id }));
    const commsAfterFirst = await prisma.orderCommunication.count({ where: { orderId: order.id } });
    await sendHandler(rec({ jobId: job.id, orderId: order.id })); // повтор
    const commsAfterSecond = await prisma.orderCommunication.count({ where: { orderId: order.id } });
    expect(commsAfterSecond).toBe(commsAfterFirst); // без дубля OrderCommunication
  });
});

describe("Global kill switch + Execution Log", () => {
  it("19. Kill switch: новые job'ы не создаются, а запланированный не отправляется (SKIP)", async () => {
    // Trigger при включённом рубильнике → job не создаётся.
    const site = await makeSite();
    const autoA = await makeAutomation(site.id);
    const orderA = await makeOrder(site.id);
    await setAutomationsGloballyDisabled(prisma, true, null);
    await fireTrigger(orderA, "ORDER_CREATED");
    expect(await jobsFor(autoA.id, orderA.id)).toHaveLength(0);

    // Job создан при выключенном рубильнике, затем рубильник включён → send SKIP.
    await setAutomationsGloballyDisabled(prisma, false, null);
    const orderB = await makeOrder(site.id);
    await fireTrigger(orderB, "ORDER_CREATED");
    const job = (await jobsFor(autoA.id, orderB.id))[0];
    expect(job.status).toBe("SCHEDULED");
    await setAutomationsGloballyDisabled(prisma, true, null);
    await sendHandler(rec({ jobId: job.id, orderId: orderB.id }));
    const updated = await prisma.automationJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(updated.status).toBe("SKIPPED");
    expect(updated.lastErrorSafe).toBe("global_kill_switch");
    await setAutomationsGloballyDisabled(prisma, false, null); // восстановить
  });

  it("20. Execution Log отражает этапы успешной отправки по порядку", async () => {
    sendOk = true;
    const site = await makeSite();
    const auto = await makeAutomation(site.id, { template: "Hi {{sender_name}}" });
    const order = await makeOrder(site.id, { senderName: "Anna" });
    await fireTrigger(order, "ORDER_CREATED");
    const job = (await jobsFor(auto.id, order.id))[0];
    await sendHandler(rec({ jobId: job.id, orderId: order.id }));

    const logs = await prisma.automationExecutionLog.findMany({ where: { jobId: job.id }, orderBy: { createdAt: "asc" }, select: { stage: true } });
    const stages = logs.map((l) => l.stage);
    for (const s of ["scheduled", "picked", "rendered", "provider_accepted", "sent"]) {
      expect(stages).toContain(s);
    }
    // Порядок ключевых этапов сохранён.
    expect(stages.indexOf("picked")).toBeLessThan(stages.indexOf("rendered"));
    expect(stages.indexOf("rendered")).toBeLessThan(stages.indexOf("sent"));
  });
});
