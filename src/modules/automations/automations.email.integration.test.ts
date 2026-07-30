import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { prisma } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import type { OutboxRecord } from "@/outbox/types";
import type { QuoClient } from "@/integrations/quo/client";
import { quoErrorFromStatus } from "@/integrations/quo/errors";
import { buildAutomationTriggerHandler, buildAutomationSendHandler } from "./handlers";
import { createSmsChannelSender } from "./channels/sms";
import { createEmailChannelSender } from "./channels/email";
import { setAutomationsGloballyDisabled } from "./settings";

/**
 * Stage 2 — Email-канал автоматизаций (обычный + fallback), на реальной БД (throwaway prisma
 * dev), Brevo замокан через fetch. Покрывает 14 проверок из ТЗ раздела 11. SMS-путь без изменений
 * уже покрыт automations.integration.test.ts (73 теста проходят без изменений).
 */

const suffix = `emailit-${Date.now()}`;
const createdSiteIds: string[] = [];
const createdOrderIds: string[] = [];

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);
const brevoJson = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let sendOk = true;
let sentCount = 0;
const fakeQuoClient = {
  async sendMessage(input: { content: string; from: string; to: string[] }) {
    if (!sendOk) throw quoErrorFromStatus(500);
    return { id: `AC-${suffix}-${sentCount++}`, status: "sent", conversationId: `CN-${suffix}`, from: input.from, to: input.to };
  },
} as unknown as QuoClient;

const triggerHandler = buildAutomationTriggerHandler(prisma);
const sendHandler = buildAutomationSendHandler(prisma, {
  channels: {
    SMS: createSmsChannelSender(() => fakeQuoClient),
    EMAIL: createEmailChannelSender(prisma),
  },
});

function rec(payload: unknown, attempts = 0, maxAttempts = 8): OutboxRecord {
  return {
    id: "evt", eventType: "x", aggregateType: "order", aggregateId: "o", payload,
    idempotencyKey: `k-${Math.random()}`, status: "PROCESSING", attempts, maxAttempts,
    availableAt: new Date(), lockedAt: new Date(), lockedBy: "test", processedAt: null,
    lastError: null, createdAt: new Date(), updatedAt: new Date(),
  };
}

async function makeSite(n: number | string) {
  const site = await prisma.site.create({
    data: {
      name: `Email Site ${suffix}-${n}`,
      shortName: `ES${n}${suffix.slice(-4)}`,
      platform: "WOOCOMMERCE",
      quoEnabled: true,
      quoPhoneNumberId: `PN-${suffix}-${n}`,
      quoPhoneNumber: "+15550000000",
    },
  });
  createdSiteIds.push(site.id);
  return site;
}

/** Полностью настроенный Email для магазина: отправитель + подтверждённый домен + шаблон события. */
async function setupSiteEmail(siteId: string, senderEmail: string, templateId: number, triggerType = "ORDER_CREATED") {
  await prisma.siteEmailSettings.create({
    data: { siteId, enabled: true, senderEmail, senderName: "Test Store", domainVerifiedAt: new Date() },
  });
  await prisma.siteEmailTemplate.create({ data: { siteId, triggerType, brevoTemplateId: templateId } });
}

async function makeOrder(siteId: string, overrides: Partial<Prisma.OrderCreateInput> = {}) {
  const order = await prisma.order.create({
    data: {
      orderNumber: `#EM-${suffix}-${Math.random().toString(36).slice(2, 8)}`,
      site: { connect: { id: siteId } },
      platform: "WOOCOMMERCE",
      source: "Website",
      externalCreatedAt: new Date(),
      deliveryDate: new Date(),
      deliveryWindow: "12:00 – 16:00",
      senderName: "Anna",
      senderPhone: "+15551112222",
      senderEmail: "customer@example.com",
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

function makeAutomation(siteId: string, overrides: Partial<Prisma.AutomationUncheckedCreateInput> = {}) {
  return prisma.automation.create({
    data: {
      sites: { create: [{ siteId }] },
      name: `auto ${suffix}`,
      active: true,
      triggerType: "ORDER_CREATED",
      audience: "CUSTOMER",
      delayAmount: 0,
      delayUnit: "IMMEDIATE",
      template: "Hi {{sender_name}}",
      smsEnabled: false,
      emailEnabled: false,
      emailFallbackEnabled: false,
      ...overrides,
    },
  });
}

async function fireTrigger(order: { id: string; siteId: string }, triggerType = "ORDER_CREATED", occurrenceKey?: string) {
  await triggerHandler(rec({ orderId: order.id, siteId: order.siteId, triggerType, occurrenceKey: occurrenceKey ?? order.id }));
}

function jobsFor(automationId: string, orderId: string) {
  return prisma.automationJob.findMany({ where: { automationId, orderId } });
}

async function sendAllScheduled(automationId: string, orderId: string) {
  const jobs = await prisma.automationJob.findMany({ where: { automationId, orderId, status: "SCHEDULED" } });
  for (const j of jobs) await sendHandler(rec({ jobId: j.id, orderId }));
}

beforeAll(async () => {
  sendOk = true;
  await setAutomationsGloballyDisabled(prisma, false, null);
});

beforeEach(() => {
  fetchMock.mockReset();
  // ВАЖНО: mockResolvedValue отдавал бы ОДИН и тот же объект Response на каждый вызов — тело
  // Response читается один раз (res.text() в brevo.ts), второй fetch в тесте падал бы с "Body
  // has already been read". mockImplementation создаёт свежий Response на каждый вызов.
  fetchMock.mockImplementation(async () => brevoJson(201, { messageId: "m" }));
  process.env.BREVO_API_KEY = "test-key";
});

afterAll(async () => {
  await prisma.automationExecutionLog.deleteMany({});
  await prisma.automationJob.deleteMany({});
  await prisma.orderCommunication.deleteMany({ where: { orderId: { in: createdOrderIds } } });
  await prisma.automation.deleteMany({});
  await prisma.siteEmailTemplate.deleteMany({ where: { siteId: { in: createdSiteIds } } });
  await prisma.siteEmailSettings.deleteMany({ where: { siteId: { in: createdSiteIds } } });
  await prisma.outboxEvent.deleteMany({ where: { eventType: { startsWith: "sms." } } });
  await prisma.order.deleteMany({ where: { id: { in: createdOrderIds } } });
  await prisma.site.deleteMany({ where: { id: { in: createdSiteIds } } });
  await prisma.$disconnect();
});

describe("1. SMS и Email отправляются одновременно", () => {
  it("оба job'а создаются и оба уходят SENT", async () => {
    const site = await makeSite(1);
    await setupSiteEmail(site.id, "orders@site1.example", 101);
    const auto = await makeAutomation(site.id, { smsEnabled: true, emailEnabled: true });
    const order = await makeOrder(site.id);
    await fireTrigger(order);

    const jobs = await jobsFor(auto.id, order.id);
    expect(jobs).toHaveLength(2);
    expect(jobs.map((j) => j.channel).sort()).toEqual(["EMAIL", "SMS"]);

    await sendAllScheduled(auto.id, order.id);
    const after = await jobsFor(auto.id, order.id);
    expect(after.every((j) => j.status === "SENT")).toBe(true);
  });
});

describe("2. Email отправляется отдельно без телефона", () => {
  it("emailEnabled=true, smsEnabled=false, у заказа нет телефона — Email всё равно уходит", async () => {
    const site = await makeSite(2);
    await setupSiteEmail(site.id, "orders@site2.example", 102);
    const auto = await makeAutomation(site.id, { smsEnabled: false, emailEnabled: true });
    const order = await makeOrder(site.id, { senderPhone: "", recipientPhone: "" });
    await fireTrigger(order);

    const jobs = await jobsFor(auto.id, order.id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].channel).toBe("EMAIL");
    await sendAllScheduled(auto.id, order.id);
    expect((await jobsFor(auto.id, order.id))[0].status).toBe("SENT");
  });
});

describe("3-4. Fallback: отсутствующий/некорректный телефон", () => {
  it("3. Телефон отсутствует + fallback включён → Email вместо SMS", async () => {
    const site = await makeSite(3);
    await setupSiteEmail(site.id, "orders@site3.example", 103);
    const auto = await makeAutomation(site.id, { smsEnabled: true, emailEnabled: false, emailFallbackEnabled: true });
    const order = await makeOrder(site.id, { senderPhone: "", recipientPhone: "" });
    await fireTrigger(order);

    const jobs = await jobsFor(auto.id, order.id);
    // SMS: SKIPPED (PHONE_MISSING) + EMAIL: SCHEDULED (fallback)
    const sms = jobs.find((j) => j.channel === "SMS");
    const email = jobs.find((j) => j.channel === "EMAIL");
    expect(sms?.status).toBe("SKIPPED");
    expect(sms?.lastErrorSafe).toBe("PHONE_MISSING");
    expect(email?.status).toBe("SCHEDULED");

    await sendAllScheduled(auto.id, order.id);
    expect((await prisma.automationJob.findUniqueOrThrow({ where: { id: email!.id } })).status).toBe("SENT");
  });

  it("4. Телефон некорректен + fallback включён → Email вместо SMS", async () => {
    const site = await makeSite(4);
    await setupSiteEmail(site.id, "orders@site4.example", 104);
    const auto = await makeAutomation(site.id, { smsEnabled: true, emailEnabled: false, emailFallbackEnabled: true, audience: "RECIPIENT" });
    const order = await makeOrder(site.id, { recipientPhone: "not-a-phone" });
    await fireTrigger(order);

    const jobs = await jobsFor(auto.id, order.id);
    const sms = jobs.find((j) => j.channel === "SMS");
    const email = jobs.find((j) => j.channel === "EMAIL");
    expect(sms?.lastErrorSafe).toBe("PHONE_INVALID");
    expect(email?.status).toBe("SCHEDULED");
    expect(email?.recipientType).toBe("CUSTOMER"); // Email ВСЕГДА заказчику, даже если SMS целился в получателя
  });
});

describe("5-6. Fallback по финальному провалу SMS", () => {
  it("5. SMS окончательно не отправилось (retries исчерпаны) → создаётся Email-fallback", async () => {
    const site = await makeSite(5);
    await setupSiteEmail(site.id, "orders@site5.example", 105);
    const auto = await makeAutomation(site.id, { smsEnabled: true, emailFallbackEnabled: true });
    const order = await makeOrder(site.id);
    await fireTrigger(order);
    const smsJob = (await jobsFor(auto.id, order.id)).find((j) => j.channel === "SMS")!;

    sendOk = false; // QUO 500 навсегда
    await sendHandler(rec({ jobId: smsJob.id, orderId: order.id }, 8, 8)); // последняя попытка → FAILED
    sendOk = true;

    const jobs = await jobsFor(auto.id, order.id);
    const sms = jobs.find((j) => j.channel === "SMS")!;
    const email = jobs.find((j) => j.channel === "EMAIL");
    expect(sms.status).toBe("FAILED");
    expect(email).toBeTruthy();
    expect(email!.status).toBe("SCHEDULED");
  });

  it("6. Успешная SMS → fallback НЕ создаётся", async () => {
    const site = await makeSite(6);
    await setupSiteEmail(site.id, "orders@site6.example", 106);
    const auto = await makeAutomation(site.id, { smsEnabled: true, emailFallbackEnabled: true });
    const order = await makeOrder(site.id);
    await fireTrigger(order);
    const smsJob = (await jobsFor(auto.id, order.id)).find((j) => j.channel === "SMS")!;

    await sendHandler(rec({ jobId: smsJob.id, orderId: order.id }));

    const jobs = await jobsFor(auto.id, order.id);
    expect(jobs).toHaveLength(1); // ни одного EMAIL-job'а не появилось
    expect(jobs[0].status).toBe("SENT");
  });
});

describe("7. Дублирующий Email не создаётся", () => {
  it("повторный trigger (тот же occurrenceKey) не плодит второй EMAIL-job", async () => {
    const site = await makeSite(7);
    await setupSiteEmail(site.id, "orders@site7.example", 107);
    const auto = await makeAutomation(site.id, { emailEnabled: true });
    const order = await makeOrder(site.id);
    await fireTrigger(order);
    await fireTrigger(order); // повтор — тот же occurrenceKey (по умолчанию orderId)
    expect(await jobsFor(auto.id, order.id)).toHaveLength(1);
  });

  it("13. Повторная обработка sms.automation.send идемпотентна (SENT не отправляется дважды)", async () => {
    const site = await makeSite(13);
    await setupSiteEmail(site.id, "orders@site13.example", 113);
    const auto = await makeAutomation(site.id, { emailEnabled: true });
    const order = await makeOrder(site.id);
    await fireTrigger(order);
    const job = (await jobsFor(auto.id, order.id))[0];
    await sendHandler(rec({ jobId: job.id, orderId: order.id }));
    const callsAfterFirst = fetchMock.mock.calls.length;
    await sendHandler(rec({ jobId: job.id, orderId: order.id })); // повтор (job уже SENT)
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirst); // ни одного нового вызова к Brevo
  });
});

describe("8-9. Настройки и брендинг правильного магазина", () => {
  it("письмо магазина A уходит с ЕГО отправителем и ЕГО Template ID, не магазина B", async () => {
    const siteA = await makeSite("8a");
    const siteB = await makeSite("8b");
    await setupSiteEmail(siteA.id, "orders@site-a.example", 201);
    await setupSiteEmail(siteB.id, "orders@site-b.example", 202);
    const autoA = await makeAutomation(siteA.id, { emailEnabled: true });
    const orderA = await makeOrder(siteA.id);
    await fireTrigger(orderA);
    const jobA = (await jobsFor(autoA.id, orderA.id))[0];
    await sendHandler(rec({ jobId: jobA.id, orderId: orderA.id }));

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.sender.email).toBe("orders@site-a.example");
    expect(body.templateId).toBe(201);
    expect(body.sender.email).not.toBe("orders@site-b.example");
    expect(body.templateId).not.toBe(202);
  });
});

describe("10. Ненастроенный домен — безопасный пропуск", () => {
  it("Email включён и отправитель задан, но домен НЕ подтверждён → SKIP на send-стадии, Brevo не вызывается", async () => {
    const site = await makeSite(10);
    // enabled:true и sender заданы, но domainVerifiedAt отсутствует — гейт должен остановить именно на этом.
    await prisma.siteEmailSettings.create({ data: { siteId: site.id, enabled: true, senderEmail: "orders@site10.example" } });
    await prisma.siteEmailTemplate.create({ data: { siteId: site.id, triggerType: "ORDER_CREATED", brevoTemplateId: 110 } });
    const auto = await makeAutomation(site.id, { emailEnabled: true });
    const order = await makeOrder(site.id);
    await fireTrigger(order);

    // На триггере job создаётся SCHEDULED (email адреса заказа достаточно) — config-гейт проверяется на send.
    const job = (await jobsFor(auto.id, order.id))[0];
    expect(job.status).toBe("SCHEDULED");

    await sendHandler(rec({ jobId: job.id, orderId: order.id }));
    const after = await prisma.automationJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(after.status).toBe("SKIPPED");
    expect(after.lastErrorSafe).toBe("site_domain_not_verified");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("Email вообще выключен у магазина → SKIP site_email_disabled на send-стадии", async () => {
    const site = await makeSite("10b");
    await prisma.siteEmailSettings.create({ data: { siteId: site.id, enabled: false, senderEmail: "orders@site10b.example" } });
    const auto = await makeAutomation(site.id, { emailEnabled: true });
    const order = await makeOrder(site.id);
    await fireTrigger(order);
    const job = (await jobsFor(auto.id, order.id))[0];
    await sendHandler(rec({ jobId: job.id, orderId: order.id }));
    const after = await prisma.automationJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(after.status).toBe("SKIPPED");
    expect(after.lastErrorSafe).toBe("site_email_disabled");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("11. Переменные подставляются в Brevo-шаблон", () => {
  it("params содержат реальные значения заказа под теми же именами, что у SMS", async () => {
    const site = await makeSite(11);
    await setupSiteEmail(site.id, "orders@site11.example", 111);
    const auto = await makeAutomation(site.id, { emailEnabled: true });
    const order = await makeOrder(site.id, { senderName: "Иван", orderNumber: "#EM-fixed-11" });
    await fireTrigger(order);
    const job = (await jobsFor(auto.id, order.id))[0];
    await sendHandler(rec({ jobId: job.id, orderId: order.id }));

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.params.sender_name).toBe("Иван");
    expect(body.params.order_number).toBe("#EM-fixed-11");
    expect(body.to[0].email).toBe("customer@example.com");
  });
});

describe("Валидация Email-получателя", () => {
  it("EMAIL_MISSING: у заказа нет senderEmail → job SKIPPED", async () => {
    const site = await makeSite(15);
    await setupSiteEmail(site.id, "orders@site15.example", 115);
    const auto = await makeAutomation(site.id, { emailEnabled: true });
    const order = await makeOrder(site.id, { senderEmail: null });
    await fireTrigger(order);
    const jobs = await jobsFor(auto.id, order.id);
    expect(jobs[0].status).toBe("SKIPPED");
    expect(jobs[0].lastErrorSafe).toBe("EMAIL_MISSING");
  });

  it("и отсутствие телефона, И отсутствие email одновременно → оба SKIPPED с разными причинами", async () => {
    const site = await makeSite(16);
    await setupSiteEmail(site.id, "orders@site16.example", 116);
    const auto = await makeAutomation(site.id, { smsEnabled: true, emailFallbackEnabled: true });
    const order = await makeOrder(site.id, { senderPhone: "", recipientPhone: "", senderEmail: null });
    await fireTrigger(order);
    const jobs = await jobsFor(auto.id, order.id);
    expect(jobs.every((j) => j.status === "SKIPPED")).toBe(true);
    const sms = jobs.find((j) => j.channel === "SMS")!;
    const email = jobs.find((j) => j.channel === "EMAIL")!;
    expect(sms.lastErrorSafe).toBe("PHONE_MISSING");
    expect(email.lastErrorSafe).toBe("EMAIL_MISSING");
  });
});

describe("Не разрешает сохранить/включить и обычный Email, и fallback одновременно (нет дублей)", () => {
  it("emailEnabled=true и emailFallbackEnabled=true вместе → только ОДИН EMAIL-job (обычный), fallback не плодит второй", async () => {
    const site = await makeSite(17);
    await setupSiteEmail(site.id, "orders@site17.example", 117);
    // smsEnabled=true + телефон невалиден + emailEnabled=true (обычный Email уже покрывает случай)
    const auto = await makeAutomation(site.id, { smsEnabled: true, emailEnabled: true, emailFallbackEnabled: true });
    const order = await makeOrder(site.id, { senderPhone: "", recipientPhone: "" });
    await fireTrigger(order);
    const jobs = await jobsFor(auto.id, order.id);
    const emailJobs = jobs.filter((j) => j.channel === "EMAIL");
    expect(emailJobs).toHaveLength(1); // не два (обычный + fallback)
  });
});

describe("Stage 2.1 — Template ID на уровне правила (override)", () => {
  it("два правила одного события у одного магазина используют РАЗНЫЕ шаблоны", async () => {
    const site = await makeSite(18);
    // Общий шаблон магазина под ORDER_CREATED (используется только тем правилом, у которого нет override).
    await setupSiteEmail(site.id, "orders@site18.example", 900);

    const autoA = await makeAutomation(site.id, { name: "rule A", emailEnabled: true, brevoTemplateId: 801 });
    const autoB = await makeAutomation(site.id, { name: "rule B", emailEnabled: true, brevoTemplateId: 802 });

    const orderA = await makeOrder(site.id);
    const orderB = await makeOrder(site.id);
    await fireTrigger(orderA);
    await fireTrigger(orderB);

    const jobA = (await jobsFor(autoA.id, orderA.id))[0];
    const jobB = (await jobsFor(autoB.id, orderB.id))[0];
    await sendHandler(rec({ jobId: jobA.id, orderId: orderA.id }));
    await sendHandler(rec({ jobId: jobB.id, orderId: orderB.id }));

    const bodyA = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    const bodyB = JSON.parse(fetchMock.mock.calls[1][1].body as string);
    expect(bodyA.templateId).toBe(801);
    expect(bodyB.templateId).toBe(802);
    expect(bodyA.templateId).not.toBe(bodyB.templateId);
  });

  it("правило БЕЗ override использует общий шаблон магазина (SiteEmailTemplate)", async () => {
    const site = await makeSite(19);
    await setupSiteEmail(site.id, "orders@site19.example", 950);
    const auto = await makeAutomation(site.id, { emailEnabled: true }); // brevoTemplateId не задан
    const order = await makeOrder(site.id);
    await fireTrigger(order);
    const job = (await jobsFor(auto.id, order.id))[0];
    await sendHandler(rec({ jobId: job.id, orderId: order.id }));
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.templateId).toBe(950);
  });

  it("override одного магазина не подходит для другого — resolveEmailTemplateForAutomation не путает site", async () => {
    const siteA = await makeSite("20a");
    const siteB = await makeSite("20b");
    await setupSiteEmail(siteA.id, "orders@site20a.example", 1001);
    await setupSiteEmail(siteB.id, "orders@site20b.example", 1002);
    // Правило с override привязано к siteA — отправитель и шаблон должны остаться его.
    const autoA = await makeAutomation(siteA.id, { emailEnabled: true, brevoTemplateId: 777 });
    const orderA = await makeOrder(siteA.id);
    await fireTrigger(orderA);
    const jobA = (await jobsFor(autoA.id, orderA.id))[0];
    await sendHandler(rec({ jobId: jobA.id, orderId: orderA.id }));
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.sender.email).toBe("orders@site20a.example");
    expect(body.sender.email).not.toBe("orders@site20b.example");
    expect(body.templateId).toBe(777); // override, не 1001 и не 1002
  });

  it("fallback использует ТОТ ЖЕ override, что назначен правилу", async () => {
    const site = await makeSite(21);
    await setupSiteEmail(site.id, "orders@site21.example", 960); // общий шаблон магазина — НЕ должен использоваться
    const auto = await makeAutomation(site.id, { smsEnabled: true, emailFallbackEnabled: true, brevoTemplateId: 861 });
    const order = await makeOrder(site.id);
    await fireTrigger(order);
    const smsJob = (await jobsFor(auto.id, order.id)).find((j) => j.channel === "SMS")!;

    sendOk = false;
    await sendHandler(rec({ jobId: smsJob.id, orderId: order.id }, 8, 8)); // финальный провал SMS
    sendOk = true;

    const emailJob = (await jobsFor(auto.id, order.id)).find((j) => j.channel === "EMAIL")!;
    expect(emailJob.status).toBe("SCHEDULED");
    await sendHandler(rec({ jobId: emailJob.id, orderId: order.id }));

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.templateId).toBe(861); // override правила, не 960
  });
});
