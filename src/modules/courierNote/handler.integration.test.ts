/**
 * Разбор инструкции курьеру на живой БД (одноразовая, `npm run test:db`), модель подменена.
 *
 * Здесь закреплено то, чего не видно в чистых функциях: что модели вообще не показывают русские
 * пометки команды, что запись инструкции и задача довезти её до Burq ставятся вместе, что на
 * «Thank you!» модель не зовут, а стёртую человеком инструкцию ИИ не пишет заново.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { prisma } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import type { DeepseekClient } from "@/integrations/deepseek/client";
import type { OutboxRecord } from "@/outbox/types";
import { buildCourierNoteHandler } from "./handler";
import { COURIER_NOTE_PUSH_EVENT, courierNoteHash } from "./events";

const suffix = `cnote-${Date.now()}`;
const RECIP = "+13105557411";
let siteId = "";
let userId = "";
const orderIds: string[] = [];

/** Модель, отвечающая по очереди заданными ответами. */
function model(...answers: unknown[]) {
  const complete = vi.fn(async () => ({ text: JSON.stringify(answers.shift() ?? { note: "" }), model: "fake", latencyMs: 1 }));
  return { client: { complete } as unknown as DeepseekClient, complete };
}

const job = (orderId: string, extra: Record<string, unknown> = {}): OutboxRecord =>
  ({ id: `job-${Math.random().toString(36).slice(2)}`, attempts: 1, createdAt: new Date(), payload: { orderId, ...extra } }) as unknown as OutboxRecord;

async function makeOrder(data: { deliveryInstructions?: string; customerNote?: string; courierNote?: string } = {}): Promise<string> {
  const o = await prisma.order.create({
    data: {
      orderNumber: `CN-${suffix}-${orderIds.length}`, site: { connect: { id: siteId } }, platform: "SHOPIFY", source: "Test", orderStatus: "CONFIRMED",
      externalCreatedAt: new Date(), deliveryDate: new Date(Date.now() + 2 * 864e5), deliveryWindow: "11:00 - 15:00",
      senderName: "Anna", senderPhone: "+13105557410", recipientName: "Ann", recipientPhone: RECIP,
      addressLine: "1 Main St", apartment: "Apt 4", city: "LA", zip: "90001",
      itemsTotal: new Prisma.Decimal(100), customerTotal: new Prisma.Decimal(100),
      ...data,
    },
    select: { id: true },
  });
  orderIds.push(o.id);
  return o.id;
}

const inbound = (orderId: string, messageText: string) =>
  prisma.orderCommunication.create({
    data: { orderId, provider: "QUO", type: "SMS", direction: "INBOUND", status: "RECEIVED", externalPhone: RECIP, externalPhoneNormalized: RECIP, messageText, occurredAt: new Date() },
    select: { id: true },
  });

const pushJobs = (orderId: string) => prisma.outboxEvent.findMany({ where: { aggregateId: orderId, eventType: COURIER_NOTE_PUSH_EVENT } });

beforeAll(async () => {
  siteId = (await prisma.site.create({ data: { name: `CN ${suffix}`, shortName: "CN", platform: "SHOPIFY" } })).id;
  userId = (await prisma.user.create({ data: { name: "CN", email: `${suffix}@test.local`, role: "OWNER", passwordHash: "x" } })).id;
});

afterAll(async () => {
  await prisma.outboxEvent.deleteMany({ where: { aggregateId: { in: orderIds } } });
  await prisma.orderCommunication.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  await prisma.user.deleteMany({ where: { id: userId } });
  await prisma.site.deleteMany({ where: { id: siteId } });
});

describe("разбор инструкции курьеру", () => {
  it("русские пометки команды модель не видит; инструкция и задача для Burq пишутся вместе", async () => {
    const orderId = await makeOrder({
      deliveryInstructions: "Gate code is #0711",
      customerNote: "частный дом, отправлять можно\nleave with the concierge",
    });
    const m = model({ note: "Gate code #0711. Leave with the concierge." });
    await buildCourierNoteHandler(prisma, { client: m.client })(job(orderId));

    const [messages] = m.complete.mock.calls[0] as unknown as [{ role: string; content: string }[]];
    const user = messages[messages.length - 1].content;
    expect(user).toContain("leave with the concierge");
    expect(user).not.toMatch(/[Ѐ-ӿ]/);

    const o = await prisma.order.findUnique({ where: { id: orderId }, select: { courierNote: true } });
    expect(o!.courierNote).toBe("Gate code #0711. Leave with the concierge.");
    const jobs = await pushJobs(orderId);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].payload).toEqual({ orderId, noteHash: courierNoteHash(o!.courierNote), notify: true });
  });

  it("выдуманное число — одна вторая попытка с объяснением, потом записывается исправленное", async () => {
    const orderId = await makeOrder({ deliveryInstructions: "Gate code is #0711" });
    const m = model({ note: "Gate code #0712." }, { note: "Gate code #0711." });
    await buildCourierNoteHandler(prisma, { client: m.client })(job(orderId));
    expect(m.complete).toHaveBeenCalledTimes(2);
    const [retry] = m.complete.mock.calls[1] as unknown as [{ role: string; content: string }[]];
    expect(retry[retry.length - 1].content).toContain("number that is not in the sources");
    expect((await prisma.order.findUnique({ where: { id: orderId }, select: { courierNote: true } }))!.courierNote).toBe("Gate code #0711.");
  });

  it("дважды выдуманное — инструкцию не трогаем и в Burq ничего не ставим", async () => {
    const orderId = await makeOrder({ deliveryInstructions: "Gate code is #0711" });
    const m = model({ note: "Gate code #0712." }, { note: "Gate code #0713." });
    await buildCourierNoteHandler(prisma, { client: m.client })(job(orderId));
    expect((await prisma.order.findUnique({ where: { id: orderId }, select: { courierNote: true } }))!.courierNote).toBe("");
    expect(await pushJobs(orderId)).toHaveLength(0);
  });

  it("по своей прошлой инструкции «нового нет» — поле и черновик Burq не трогаются", async () => {
    const orderId = await makeOrder({ deliveryInstructions: "Gate code is #0711", courierNote: "Gate code #0711." });
    const m = model({ changed: false, note: "" });
    await buildCourierNoteHandler(prisma, { client: m.client })(job(orderId));
    expect((await prisma.order.findUnique({ where: { id: orderId }, select: { courierNote: true } }))!.courierNote).toBe("Gate code #0711.");
    expect(await pushJobs(orderId)).toHaveLength(0);
  });

  it("«Thank you!» в SMS модель не зовёт", async () => {
    const orderId = await makeOrder({ deliveryInstructions: "Gate code is #0711" });
    const c = await inbound(orderId, "Thank you!");
    const m = model({ note: "Gate code #0711." });
    await buildCourierNoteHandler(prisma, { client: m.client })(job(orderId, { communicationId: c.id }));
    expect(m.complete).not.toHaveBeenCalled();
  });

  it("код из SMS клиента попадает в инструкцию", async () => {
    const orderId = await makeOrder();
    const c = await inbound(orderId, "any time, the gate code is 1408");
    const m = model({ note: "Gate code 1408." });
    await buildCourierNoteHandler(prisma, { client: m.client })(job(orderId, { communicationId: c.id }));
    expect((await prisma.order.findUnique({ where: { id: orderId }, select: { courierNote: true } }))!.courierNote).toBe("Gate code 1408.");
  });

  it("инструкцию человека ИИ не переписывает — дописывает строкой ниже", async () => {
    const orderId = await makeOrder({ courierNote: "Ring twice" });
    await prisma.orderAudit.create({ data: { orderId, userId, role: "OWNER", block: "courierNote", changed: { courierNote: { from: "", to: "Ring twice" } } } });
    const c = await inbound(orderId, "gate code is 1408");
    const m = model({ note: "Gate code 1408." });
    await buildCourierNoteHandler(prisma, { client: m.client })(job(orderId, { communicationId: c.id }));
    expect((await prisma.order.findUnique({ where: { id: orderId }, select: { courierNote: true } }))!.courierNote).toBe("Ring twice\nGate code 1408.");
  });

  it("стёртую человеком инструкцию ИИ не пишет заново", async () => {
    const orderId = await makeOrder({ deliveryInstructions: "Gate code is #0711" });
    await prisma.orderAudit.create({ data: { orderId, userId, role: "OWNER", block: "courierNote", changed: { courierNote: { from: "Gate code #0711.", to: "" } } } });
    const m = model({ note: "Gate code #0711." });
    await buildCourierNoteHandler(prisma, { client: m.client })(job(orderId));
    expect(m.complete).not.toHaveBeenCalled();
  });

  it("закрытый заказ не разбирается", async () => {
    const orderId = await makeOrder({ deliveryInstructions: "Gate code is #0711" });
    await prisma.order.update({ where: { id: orderId }, data: { orderStatus: "DELIVERED" } });
    const m = model({ note: "Gate code #0711." });
    await buildCourierNoteHandler(prisma, { client: m.client })(job(orderId));
    expect(m.complete).not.toHaveBeenCalled();
  });
});
