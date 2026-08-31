import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { prisma } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import type { OutboxRecord } from "@/outbox/types";
import { buildAutomationTriggerHandler } from "../handlers";
import { AUTOMATION_TRIGGER_EVENT } from "../events";
import { buildFlowStepHandler } from "./handler";
import { FLOW_STEP_EVENT } from "./events";
import type { ChannelSender, ChannelSendResult } from "@/modules/messaging/channels/types";
import { ingestWooOrder, type WooIngestConfig } from "@/integrations/woocommerce/ingestWooOrder";

/**
 * Automation Flows на реальной БД (throwaway prisma dev). Прогоняем настоящие обработчики
 * (trigger → старт цепочки, flow.step → выполнение шага); worker в этой цепочке только
 * диспетчер по eventType, поэтому его роль здесь играет drainFlowSteps.
 *
 * Каналы подменены фейковыми ChannelSender — проверяется движок цепочек, а не Brevo/QUO.
 * Ожидание не «пережидаем»: WAIT планируется на будущее, и мы проверяем ИМЕННО эту дату,
 * после чего вызываем обработчик — ровно то, что сделает worker, когда время придёт.
 */

const suffix = `flowit-${Date.now()}`;
const createdSiteIds: string[] = [];
const createdOrderIds: string[] = [];

// ── Фейковые каналы ──
type Outcome = "ok" | "retryable" | "fail" | "skip";
let emailOutcome: Outcome = "ok";
let smsOutcome: Outcome = "ok";
const emailSends: { idempotencyKey: string; templateId: number | null; to: string | null }[] = [];
const smsSends: { idempotencyKey: string; text: string; to: string | null }[] = [];

function outcomeToResult(outcome: Outcome, providerMessageId: string): ChannelSendResult {
  if (outcome === "ok") return { ok: true, providerMessageId };
  if (outcome === "retryable") return { ok: false, code: "provider_server", retryable: true };
  if (outcome === "skip") return { ok: false, code: "site_email_disabled", retryable: false, skip: true };
  return { ok: false, code: "provider_bad_request", retryable: false };
}

const fakeEmail: ChannelSender = {
  channel: "EMAIL",
  async send(ctx) {
    emailSends.push({ idempotencyKey: ctx.idempotencyKey, templateId: ctx.emailTemplateIdOverride, to: ctx.emailNormalized });
    return outcomeToResult(emailOutcome, `email-${emailSends.length}`);
  },
};

const fakeSms: ChannelSender = {
  channel: "SMS",
  async send(ctx) {
    smsSends.push({ idempotencyKey: ctx.idempotencyKey, text: ctx.text, to: ctx.phoneNormalized });
    return outcomeToResult(smsOutcome, `sms-${smsSends.length}`);
  },
};

const channels = { EMAIL: fakeEmail, SMS: fakeSms };
const triggerHandler = buildAutomationTriggerHandler(prisma);
const flowHandler = buildFlowStepHandler(prisma, { channels });

function rec(payload: unknown, attempts = 0, maxAttempts = 8): OutboxRecord {
  return {
    id: "evt", eventType: "x", aggregateType: "order", aggregateId: "o", payload,
    idempotencyKey: `k-${Math.random()}`, status: "PROCESSING", attempts, maxAttempts,
    availableAt: new Date(), lockedAt: new Date(), lockedBy: "test", processedAt: null,
    lastError: null, createdAt: new Date(), updatedAt: new Date(),
  };
}

/**
 * Один «тик» worker'а по шагам цепочек: берём накопившиеся события, выполняем их обработчиком.
 * Успех → PROCESSED; исключение → событие остаётся PENDING (так outbox и повторяет попытку).
 */
async function drainFlowSteps(orderId: string, opts: { attempts?: number; maxAttempts?: number } = {}): Promise<{ processed: number; retried: number }> {
  // Строго по одному заказу: тесты делят одну БД, и чужие незавершённые шаги не должны
  // попадать в этот «тик».
  const events = await prisma.outboxEvent.findMany({
    where: { eventType: FLOW_STEP_EVENT, status: "PENDING", aggregateId: orderId },
    orderBy: { createdAt: "asc" },
  });
  let processed = 0;
  let retried = 0;
  for (const e of events) {
    try {
      await flowHandler(rec(e.payload, opts.attempts ?? 0, opts.maxAttempts ?? 8));
      await prisma.outboxEvent.update({ where: { id: e.id }, data: { status: "PROCESSED" } });
      processed++;
    } catch {
      retried++; // остаётся PENDING → worker повторит с backoff
    }
  }
  return { processed, retried };
}

/** Прогоняет цепочку до конца (каждый проход выполняет ровно один «слой» шагов). */
async function drainAll(orderId: string, maxPasses = 10): Promise<void> {
  for (let i = 0; i < maxPasses; i++) {
    const { processed } = await drainFlowSteps(orderId);
    if (processed === 0) return;
  }
}

async function makeSite() {
  const site = await prisma.site.create({
    data: {
      name: `Flow Site ${suffix}-${createdSiteIds.length}`,
      shortName: `FL${createdSiteIds.length}${Date.now() % 10000}`,
      platform: "WOOCOMMERCE",
      quoEnabled: true,
      quoPhoneNumber: "+15550000000",
    },
  });
  createdSiteIds.push(site.id);
  return site;
}

async function makeOrder(siteId: string, overrides: Partial<Prisma.OrderUncheckedCreateInput> = {}) {
  const order = await prisma.order.create({
    data: {
      orderNumber: `#FL-${suffix}-${Math.random().toString(36).slice(2, 8)}`,
      siteId,
      platform: "WOOCOMMERCE",
      source: "Website",
      externalCreatedAt: new Date(),
      deliveryDate: new Date(),
      deliveryWindow: "12:00 – 16:00",
      senderName: "Anna",
      senderPhone: "+15551112222",
      senderEmail: "anna@example.com",
      recipientName: "Maria",
      recipientPhone: "+15553334444",
      addressLine: "1 Main St",
      city: "Portland",
      zip: "00000",
      itemsTotal: new Prisma.Decimal(100),
      customerTotal: new Prisma.Decimal(115),
      paymentStatus: "PAID",
      orderStatus: "DELIVERED",
      ...overrides,
    },
  });
  createdOrderIds.push(order.id);
  return order;
}

type StepSeed = {
  type: "WAIT" | "EMAIL" | "SMS";
  waitAmount?: number | null;
  waitUnit?: "MINUTE" | "HOUR" | "DAY" | null;
  brevoTemplateId?: number | null;
  template?: string | null;
};

async function makeFlow(siteId: string, steps: StepSeed[], overrides: { active?: boolean; triggerType?: string; name?: string } = {}) {
  return prisma.automationFlow.create({
    data: {
      name: overrides.name ?? `flow ${suffix}`,
      active: overrides.active ?? true,
      triggerType: overrides.triggerType ?? "ORDER_DELIVERED",
      sites: { create: [{ siteId }] },
      steps: {
        create: steps.map((s, i) => ({
          position: i + 1,
          type: s.type,
          waitAmount: s.waitAmount ?? null,
          waitUnit: s.waitUnit ?? null,
          brevoTemplateId: s.brevoTemplateId ?? null,
          template: s.template ?? null,
        })),
      },
    },
    include: { steps: { orderBy: { position: "asc" } } },
  });
}

async function fireTrigger(order: { id: string; siteId: string }, triggerType = "ORDER_DELIVERED", occurrenceKey?: string) {
  await triggerHandler(rec({ orderId: order.id, siteId: order.siteId, triggerType, occurrenceKey: occurrenceKey ?? order.id }));
}

const runsOf = (flowId: string) => prisma.automationFlowRun.findMany({ where: { flowId }, include: { steps: { orderBy: { position: "asc" } } } });

beforeEach(() => {
  emailOutcome = "ok";
  smsOutcome = "ok";
  emailSends.length = 0;
  smsSends.length = 0;
});

afterAll(async () => {
  await prisma.automationFlowRun.deleteMany({ where: { siteId: { in: createdSiteIds } } });
  await prisma.automationFlow.deleteMany({ where: { sites: { some: { siteId: { in: createdSiteIds } } } } });
  await prisma.automationJob.deleteMany({ where: { orderId: { in: createdOrderIds } } });
  await prisma.automation.deleteMany({ where: { sites: { some: { siteId: { in: createdSiteIds } } } } });
  await prisma.outboxEvent.deleteMany({ where: { aggregateId: { in: [...createdOrderIds, ...createdSiteIds] } } });
  await prisma.order.deleteMany({ where: { siteId: { in: createdSiteIds } } });
  await prisma.site.deleteMany({ where: { id: { in: createdSiteIds } } });
});

describe("первый рабочий сценарий: ORDER_DELIVERED → WAIT 2 дня → EMAIL", () => {
  it("проходит целиком и отправляет письмо ровно один раз", async () => {
    const site = await makeSite();
    const order = await makeOrder(site.id);
    const flow = await makeFlow(site.id, [
      { type: "WAIT", waitAmount: 2, waitUnit: "DAY" },
      { type: "EMAIL", brevoTemplateId: 77 },
    ]);

    const before = Date.now();
    await fireTrigger(order);

    // Старт: run активен, запланирован ТОЛЬКО первый шаг — и ровно через 2 дня.
    let runs = await runsOf(flow.id);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("ACTIVE");
    expect(runs[0].steps).toHaveLength(1);
    expect(runs[0].steps[0].type).toBe("WAIT");
    expect(runs[0].steps[0].status).toBe("SCHEDULED");
    const waitMs = runs[0].steps[0].scheduledAt.getTime() - before;
    expect(waitMs).toBeGreaterThan(2 * 86_400_000 - 60_000);
    expect(waitMs).toBeLessThan(2 * 86_400_000 + 60_000);
    expect(runs[0].nextRunAt?.getTime()).toBe(runs[0].steps[0].scheduledAt.getTime());
    expect(emailSends).toHaveLength(0); // до истечения ожидания письма нет

    // Время пришло: worker выполняет WAIT, следом планируется письмо.
    await drainFlowSteps(order.id);
    runs = await runsOf(flow.id);
    expect(runs[0].steps.map((s) => [s.type, s.status])).toEqual([
      ["WAIT", "SENT"],
      ["EMAIL", "SCHEDULED"],
    ]);

    await drainFlowSteps(order.id);
    runs = await runsOf(flow.id);
    const emailStep = runs[0].steps[1];
    expect(emailStep.status).toBe("SENT");
    expect(emailStep.providerMessageId).toBe("email-1");
    expect(emailStep.emailNormalized).toBe("anna@example.com");
    expect(emailStep.sentAt).not.toBeNull();

    // Цепочка закончилась.
    expect(runs[0].status).toBe("COMPLETED");
    expect(runs[0].nextRunAt).toBeNull();
    expect(runs[0].finishedAt).not.toBeNull();

    expect(emailSends).toHaveLength(1);
    expect(emailSends[0].templateId).toBe(77);
  });
});

describe("идемпотентность", () => {
  it("повторный триггер не создаёт второй run", async () => {
    const site = await makeSite();
    const order = await makeOrder(site.id);
    const flow = await makeFlow(site.id, [{ type: "EMAIL", brevoTemplateId: 5 }]);

    await fireTrigger(order);
    await fireTrigger(order); // тот же occurrenceKey
    await fireTrigger(order, "ORDER_DELIVERED", `${order.id}:ORDER_DELIVERED`); // другой источник факта

    const runs = await runsOf(flow.id);
    expect(runs).toHaveLength(1);
    expect(runs[0].steps).toHaveLength(1);
  });

  it("повторная доставка outbox-события не отправляет письмо дважды", async () => {
    const site = await makeSite();
    const order = await makeOrder(site.id);
    const flow = await makeFlow(site.id, [{ type: "EMAIL", brevoTemplateId: 5 }]);

    await fireTrigger(order);
    await drainFlowSteps(order.id);
    expect(emailSends).toHaveLength(1);

    // Worker получил то же событие повторно (перезапуск, восстановление зависшего lease).
    const runs = await runsOf(flow.id);
    const runStepId = runs[0].steps[0].id;
    await flowHandler(rec({ runStepId, orderId: order.id }));
    await flowHandler(rec({ runStepId, orderId: order.id }));

    expect(emailSends).toHaveLength(1); // второй отправки не было
    const after = await runsOf(flow.id);
    expect(after[0].steps).toHaveLength(1);
    expect(after[0].steps[0].status).toBe("SENT");
  });

  it("повторный advance не дублирует шаг цепочки", async () => {
    const site = await makeSite();
    const order = await makeOrder(site.id);
    const flow = await makeFlow(site.id, [
      { type: "WAIT", waitAmount: 1, waitUnit: "MINUTE" },
      { type: "EMAIL", brevoTemplateId: 5 },
    ]);

    await fireTrigger(order);
    await drainFlowSteps(order.id); // WAIT → планируется EMAIL

    // Повторная обработка события WAIT (уже SENT) не должна ничего планировать заново.
    const runs = await runsOf(flow.id);
    await flowHandler(rec({ runStepId: runs[0].steps[0].id, orderId: order.id }));

    const after = await runsOf(flow.id);
    expect(after[0].steps).toHaveLength(2);
  });
});

describe("ошибки и повторы", () => {
  it("временная ошибка повторяется, шаг остаётся запланированным", async () => {
    const site = await makeSite();
    const order = await makeOrder(site.id);
    const flow = await makeFlow(site.id, [{ type: "EMAIL", brevoTemplateId: 9 }]);

    await fireTrigger(order);

    emailOutcome = "retryable";
    const first = await drainFlowSteps(order.id);
    expect(first.retried).toBe(1); // обработчик бросил → outbox повторит
    expect(first.processed).toBe(0);

    let runs = await runsOf(flow.id);
    expect(runs[0].steps[0].status).toBe("SCHEDULED"); // шаг ещё в работе
    expect(runs[0].steps[0].attempts).toBe(1);
    expect(runs[0].steps[0].lastErrorSafe).toBe("provider_server");
    expect(runs[0].status).toBe("ACTIVE");

    // Повтор удался.
    emailOutcome = "ok";
    await drainFlowSteps(order.id);
    runs = await runsOf(flow.id);
    expect(runs[0].steps[0].status).toBe("SENT");
    expect(runs[0].status).toBe("COMPLETED");

    // Ключ идемпотентности отправки — per-attempt, иначе настоящий повтор не прошёл бы.
    expect(emailSends).toHaveLength(2);
    expect(emailSends[0].idempotencyKey).toMatch(/:a0$/);
    expect(emailSends[1].idempotencyKey).toMatch(/:a1$/);
  });

  it("исчерпанные попытки → FAILED, но цепочка продолжает следующий шаг", async () => {
    const site = await makeSite();
    const order = await makeOrder(site.id);
    const flow = await makeFlow(site.id, [
      { type: "EMAIL", brevoTemplateId: 9 },
      { type: "SMS", template: "Спасибо за заказ {{order_number}}" },
    ]);

    await fireTrigger(order);

    emailOutcome = "retryable";
    // Последняя попытка события (attempts >= maxAttempts) — повторять больше нечем.
    await drainFlowSteps(order.id, { attempts: 8, maxAttempts: 8 });

    let runs = await runsOf(flow.id);
    expect(runs[0].steps[0].status).toBe("FAILED");
    expect(runs[0].steps[0].lastErrorSafe).toBe("provider_server");
    expect(runs[0].steps[0].failedAt).not.toBeNull();
    // Цепочка НЕ остановлена: следующий шаг уже запланирован.
    expect(runs[0].status).toBe("ACTIVE");
    expect(runs[0].steps).toHaveLength(2);
    expect(runs[0].steps[1].status).toBe("SCHEDULED");

    await drainFlowSteps(order.id);
    runs = await runsOf(flow.id);
    expect(runs[0].steps[1].status).toBe("SENT");
    expect(runs[0].status).toBe("COMPLETED");
    expect(smsSends).toHaveLength(1);
    expect(smsSends[0].text).toContain(order.orderNumber);
  });

  it("непреодолимая ошибка канала (магазин не настроен) → SKIPPED, цепочка идёт дальше", async () => {
    const site = await makeSite();
    const order = await makeOrder(site.id);
    const flow = await makeFlow(site.id, [
      { type: "EMAIL", brevoTemplateId: 9 },
      { type: "SMS", template: "Текст" },
    ]);

    await fireTrigger(order);
    emailOutcome = "skip";
    await drainFlowSteps(order.id);

    const runs = await runsOf(flow.id);
    expect(runs[0].steps[0].status).toBe("SKIPPED");
    expect(runs[0].steps[0].lastErrorSafe).toBe("site_email_disabled");
    expect(runs[0].steps[1].status).toBe("SCHEDULED");
  });
});

describe("гейты запуска и остановки", () => {
  it("выключенная цепочка не запускается", async () => {
    const site = await makeSite();
    const order = await makeOrder(site.id);
    const flow = await makeFlow(site.id, [{ type: "EMAIL", brevoTemplateId: 1 }], { active: false });

    await fireTrigger(order);

    expect(await runsOf(flow.id)).toHaveLength(0);
    expect(emailSends).toHaveLength(0);
  });

  it("цепочка на ДРУГОЕ событие не запускается", async () => {
    const site = await makeSite();
    const order = await makeOrder(site.id);
    const flow = await makeFlow(site.id, [{ type: "EMAIL", brevoTemplateId: 1 }], { triggerType: "ORDER_PAID" });

    await fireTrigger(order, "ORDER_DELIVERED");

    expect(await runsOf(flow.id)).toHaveLength(0);
  });

  it("цепочку выключили во время выполнения → run останавливается, письмо не уходит", async () => {
    const site = await makeSite();
    const order = await makeOrder(site.id);
    const flow = await makeFlow(site.id, [
      { type: "WAIT", waitAmount: 1, waitUnit: "MINUTE" },
      { type: "EMAIL", brevoTemplateId: 3 },
    ]);

    await fireTrigger(order);
    await drainFlowSteps(order.id); // WAIT выполнен, письмо запланировано

    await prisma.automationFlow.update({ where: { id: flow.id }, data: { active: false } });
    await drainFlowSteps(order.id);

    const runs = await runsOf(flow.id);
    expect(runs[0].status).toBe("CANCELLED");
    expect(runs[0].cancelledReason).toBe("flow_disabled");
    expect(runs[0].steps[1].status).toBe("CANCELLED");
    expect(emailSends).toHaveLength(0);
  });

  it("магазин отвязали от цепочки → run останавливается", async () => {
    const site = await makeSite();
    const order = await makeOrder(site.id);
    const flow = await makeFlow(site.id, [{ type: "EMAIL", brevoTemplateId: 3 }]);

    await fireTrigger(order);
    await prisma.automationFlowSite.delete({ where: { flowId_siteId: { flowId: flow.id, siteId: site.id } } });
    await drainFlowSteps(order.id);

    const runs = await runsOf(flow.id);
    expect(runs[0].status).toBe("CANCELLED");
    expect(runs[0].cancelledReason).toBe("site_unlinked");
    expect(emailSends).toHaveLength(0);
  });

  it("заказ отменили во время ожидания → run останавливается", async () => {
    const site = await makeSite();
    const order = await makeOrder(site.id);
    const flow = await makeFlow(site.id, [{ type: "EMAIL", brevoTemplateId: 3 }]);

    await fireTrigger(order);
    await prisma.order.update({ where: { id: order.id }, data: { orderStatus: "CANCELLED" } });
    await drainFlowSteps(order.id);

    const runs = await runsOf(flow.id);
    expect(runs[0].status).toBe("CANCELLED");
    expect(runs[0].cancelledReason).toBe("order_cancelled");
    expect(emailSends).toHaveLength(0);
  });

  it("заказ исключён из рассылок → цепочка останавливается, письма нет", async () => {
    // Владелец пометил заказ в карточке: маркетинг по нему молчит и сейчас, и в будущем.
    const site = await makeSite();
    const order = await makeOrder(site.id);
    const flow = await makeFlow(site.id, [{ type: "EMAIL", brevoTemplateId: 3 }]);

    await fireTrigger(order);
    await prisma.order.update({ where: { id: order.id }, data: { marketingMark: "MUTED" } });
    await drainFlowSteps(order.id);

    const runs = await runsOf(flow.id);
    expect(runs[0].status).toBe("CANCELLED");
    expect(runs[0].cancelledReason).toBe("order_marketing_muted");
    expect(emailSends).toHaveLength(0);
  });

  it("отметка «исключён» гасит и ВТОРУЮ цепочку, запущенную позже", async () => {
    // Смысл отметки — «все следующие рассылки», а не только та, что уже шла.
    const site = await makeSite();
    const order = await makeOrder(site.id);
    await prisma.order.update({ where: { id: order.id }, data: { marketingMark: "MUTED" } });
    const flow = await makeFlow(site.id, [{ type: "EMAIL", brevoTemplateId: 3 }]);

    await fireTrigger(order);
    await drainFlowSteps(order.id);

    const runs = await runsOf(flow.id);
    expect(runs[0].cancelledReason).toBe("order_marketing_muted");
    expect(emailSends).toHaveLength(0);
  });

  it("пометка «попросить отзыв» цепочку НЕ останавливает", async () => {
    // Граница двух значений: MUTED — запрет на письма, ASK_REVIEW — задача оператору.
    // Спутать их значило бы молча отменить рассылку там, где владелец её как раз хотел.
    const site = await makeSite();
    const order = await makeOrder(site.id);
    await makeFlow(site.id, [{ type: "EMAIL", brevoTemplateId: 3 }]);

    await prisma.order.update({ where: { id: order.id }, data: { marketingMark: "ASK_REVIEW" } });
    await fireTrigger(order);
    await drainFlowSteps(order.id);

    expect(emailSends).toHaveLength(1);
  });

  it("шаг удалили во время ожидания → SKIPPED, цепочка идёт дальше", async () => {
    const site = await makeSite();
    const order = await makeOrder(site.id);
    const flow = await makeFlow(site.id, [
      { type: "EMAIL", brevoTemplateId: 3 },
      { type: "SMS", template: "Текст" },
    ]);

    await fireTrigger(order);
    await prisma.automationFlowStep.update({ where: { id: flow.steps[0].id }, data: { deletedAt: new Date() } });
    await drainAll(order.id);

    const runs = await runsOf(flow.id);
    expect(runs[0].steps[0].status).toBe("SKIPPED");
    expect(runs[0].steps[0].lastErrorSafe).toBe("step_deleted");
    expect(runs[0].steps[1].status).toBe("SENT");
    expect(runs[0].status).toBe("COMPLETED");
    expect(emailSends).toHaveLength(0);
  });
});

describe("совместимость с существующим движком", () => {
  it("одиночное правило и цепочка на одном событии работают независимо", async () => {
    const site = await makeSite();
    const order = await makeOrder(site.id);

    const automation = await prisma.automation.create({
      data: {
        sites: { create: [{ siteId: site.id }] },
        name: `rule ${suffix}`,
        active: true,
        triggerType: "ORDER_DELIVERED",
        audience: "CUSTOMER",
        delayAmount: 0,
        delayUnit: "IMMEDIATE",
        template: "Ваш заказ {{order_number}} доставлен",
      },
    });
    const flow = await makeFlow(site.id, [{ type: "EMAIL", brevoTemplateId: 42 }]);

    await fireTrigger(order);

    // Одиночное правило по-прежнему создаёт свой job (его отправка — отдельный обработчик).
    const jobs = await prisma.automationJob.findMany({ where: { automationId: automation.id, orderId: order.id } });
    expect(jobs).toHaveLength(1);
    expect(jobs[0].status).toBe("SCHEDULED");
    expect(jobs[0].channel).toBe("SMS");

    // И цепочка стартовала своим путём.
    const runs = await runsOf(flow.id);
    expect(runs).toHaveLength(1);
    expect(runs[0].steps).toHaveLength(1);

    await drainFlowSteps(order.id);
    expect(emailSends).toHaveLength(1);

    // Шаги цепочки не создали AutomationJob — модели не пересекаются.
    const jobsAfter = await prisma.automationJob.findMany({ where: { orderId: order.id } });
    expect(jobsAfter).toHaveLength(1);
  });

  it("цепочка без одиночных правил всё равно стартует", async () => {
    const site = await makeSite();
    const order = await makeOrder(site.id);
    const flow = await makeFlow(site.id, [{ type: "EMAIL", brevoTemplateId: 8 }]);

    await fireTrigger(order); // на этом сайте одиночных правил нет вовсе

    expect(await runsOf(flow.id)).toHaveLength(1);
  });
});

describe("resync / backfill", () => {
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

  const wooOrder = (id: number, status: string, at: string) => ({
    id,
    number: String(id),
    status,
    date_created_gmt: "2026-08-01T10:00:00",
    date_modified_gmt: at,
    billing: { first_name: "John", last_name: "Buyer", phone: "+15551112222", email: "j@x.com" },
    shipping: { first_name: "Ann", last_name: "R", phone: "+15553334444", address_1: "1 St", city: "Town", postcode: "1000" },
    line_items: [{ id: 1, name: "Rose", product_id: 100, quantity: 1, price: "100" }],
    total: "100", total_tax: "0", shipping_total: "0", discount_total: "0",
  });

  it("bulk-sync (без emitLifecycle) не публикует триггер и не запускает цепочку", async () => {
    const site = await makeSite();
    const flow = await makeFlow(site.id, [{ type: "EMAIL", brevoTemplateId: 4 }]);
    const siteRef = { id: site.id, shortName: site.shortName };

    await ingestWooOrder(siteRef, wooOrder(8801, "processing", "2026-08-01T10:00:00") as never, ingestConfig);
    const created = await prisma.order.findFirst({ where: { siteId: site.id, externalId: "8801" }, select: { id: true } });
    createdOrderIds.push(created!.id);
    await ingestWooOrder(siteRef, wooOrder(8801, "completed", "2026-08-01T11:00:00") as never, ingestConfig);

    const triggers = await prisma.outboxEvent.findMany({
      where: { eventType: AUTOMATION_TRIGGER_EVENT, aggregateId: created!.id },
    });
    expect(triggers).toHaveLength(0);
    expect(await runsOf(flow.id)).toHaveLength(0);
  });

  it("живой webhook публикует триггер «доставлен» — цепочка стартует", async () => {
    const site = await makeSite();
    const flow = await makeFlow(site.id, [{ type: "EMAIL", brevoTemplateId: 4 }]);
    const siteRef = { id: site.id, shortName: site.shortName };

    await ingestWooOrder(siteRef, wooOrder(8802, "processing", "2026-08-01T10:00:00") as never, ingestConfig, { emitLifecycle: true });
    const created = await prisma.order.findFirst({ where: { siteId: site.id, externalId: "8802" }, select: { id: true } });
    createdOrderIds.push(created!.id);
    await ingestWooOrder(siteRef, wooOrder(8802, "completed", "2026-08-01T11:00:00") as never, ingestConfig, { emitLifecycle: true });

    // Триггер лежит в outbox — прогоняем его тем же обработчиком, что и worker.
    const trigger = await prisma.outboxEvent.findFirst({
      where: { eventType: AUTOMATION_TRIGGER_EVENT, aggregateId: created!.id, idempotencyKey: { contains: "ORDER_DELIVERED" } },
    });
    expect(trigger).not.toBeNull();
    await triggerHandler(rec(trigger!.payload));

    const runs = await runsOf(flow.id);
    expect(runs).toHaveLength(1);
    expect(runs[0].orderId).toBe(created!.id);
  });
});
