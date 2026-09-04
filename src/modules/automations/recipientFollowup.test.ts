import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";

const enqueue = vi.fn();
vi.mock("@/outbox/prismaRepository", () => ({
  PrismaOutboxRepository: class {
    enqueue = enqueue;
  },
}));

const publishAutomationTrigger = vi.fn();
vi.mock("./events", () => ({
  publishAutomationTrigger: (...a: unknown[]) => publishAutomationTrigger(...a),
}));

import {
  scheduleRecipientFollowup,
  buildRecipientFollowupHandler,
  WAIT_AFTER_ASK_MIN,
  WAIT_AFTER_RETRY_MIN,
} from "./recipientFollowup";

/**
 * Эскалация «получатель молчит»: вопрос → +60 мин повтор ему → +20 мин заказчику.
 *
 * Главное, что закрепляют тесты: каждый шаг ровно один раз и цепочка гаснет, как только
 * продолжать незачем. Лишнее SMS здесь — не косметика: это сообщение реальному человеку,
 * а на волне 2 ещё и тревога заказчику по поводу заказа, с которым всё в порядке.
 */
const ASKED_AT = new Date("2026-09-04T17:00:00.000Z"); // 10:00 в Лос-Анджелесе
/** Order.deliveryDate — UTC-полночь ЛОКАЛЬНОГО дня доставки. */
const DELIVERY_DAY = new Date("2026-09-04T00:00:00.000Z");

const baseOrder = (over: Record<string, unknown> = {}) => ({
  id: "o1",
  siteId: "s1",
  orderStatus: "CONFIRMED",
  deliveryStatus: "PENDING",
  deliveryDate: DELIVERY_DAY,
  site: { timezone: "America/Los_Angeles" },
  ...over,
});

function prismaWith(opts: {
  order?: Record<string, unknown> | null;
  inboundFound?: boolean;
  /** Правило, которым задан вопрос: null = удалено. */
  automation?: Record<string, unknown> | null;
} = {}): PrismaClient {
  const order = opts.order === undefined ? baseOrder() : opts.order;
  const automation =
    opts.automation === undefined ? { active: true, deletedAt: null, awaitRecipientReply: true } : opts.automation;
  return {
    order: { findUnique: vi.fn().mockResolvedValue(order) },
    automation: { findUnique: vi.fn().mockResolvedValue(automation) },
    orderCommunication: { findFirst: vi.fn().mockResolvedValue(opts.inboundFound ? { id: "c1" } : null) },
  } as unknown as PrismaClient;
}

const record = (wave: 1 | 2, over: Record<string, unknown> = {}) => ({
  payload: {
    orderId: "o1",
    wave,
    askedAt: ASKED_AT.toISOString(),
    phoneNormalized: "+13105550100",
    deliveryDay: "2026-09-04",
    automationId: "a1",
    ...over,
  },
});

beforeEach(() => {
  enqueue.mockReset();
  publishAutomationTrigger.mockReset();
  vi.useRealTimers();
});

describe("планирование первой проверки", () => {
  it("ставится ровно через час после фактической отправки вопроса", async () => {
    await scheduleRecipientFollowup(prismaWith(), { orderId: "o1", phoneNormalized: "+13105550100", sentAt: ASKED_AT });

    const arg = enqueue.mock.calls[0][0];
    expect(arg.idempotencyKey).toBe("recipient-followup:o1:2026-09-04:1");
    expect(arg.availableAt.getTime()).toBe(ASKED_AT.getTime() + WAIT_AFTER_ASK_MIN * 60_000);
  });

  it("перенос доставки на другой день начинает цепочку заново — у дня свой ключ", async () => {
    // История: ключ был `recipient-followup:<заказ>:1`, без дня. Заказ переносили, вопрос уходил
    // второй раз, а страховка молча не вставала — ровно на тех заказах, где получатель уже один
    // раз не отозвался и заказ из-за этого и перенесли.
    await scheduleRecipientFollowup(prismaWith(), { orderId: "o1", phoneNormalized: "+13105550100", sentAt: ASKED_AT });
    const moved = prismaWith({ order: baseOrder({ deliveryDate: new Date("2026-09-05T00:00:00.000Z") }) });
    await scheduleRecipientFollowup(moved, { orderId: "o1", phoneNormalized: "+13105550100", sentAt: ASKED_AT });

    expect(enqueue.mock.calls.map((c) => c[0].idempotencyKey)).toEqual([
      "recipient-followup:o1:2026-09-04:1",
      "recipient-followup:o1:2026-09-05:1",
    ]);
  });

  it("день доставки уезжает в payload — по нему волна поймёт, что устарела", async () => {
    await scheduleRecipientFollowup(prismaWith(), { orderId: "o1", phoneNormalized: "+13105550100", sentAt: ASKED_AT, automationId: "a1" });
    expect(enqueue.mock.calls[0][0].payload).toMatchObject({ deliveryDay: "2026-09-04", automationId: "a1" });
  });

  it("у заказа нет даты доставки — цепочку не к чему привязать, не заводим", async () => {
    await scheduleRecipientFollowup(prismaWith({ order: baseOrder({ deliveryDate: null }) }), {
      orderId: "o1",
      phoneNormalized: "+13105550100",
      sentAt: ASKED_AT,
    });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("без номера получателя цепочка не заводится — отвечать некому", async () => {
    await scheduleRecipientFollowup(prismaWith(), { orderId: "o1", phoneNormalized: null, sentAt: ASKED_AT });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("ключ идемпотентности один на заказ и день — второе правило не заведёт вторую цепочку", async () => {
    await scheduleRecipientFollowup(prismaWith(), { orderId: "o1", phoneNormalized: "+13105550100", sentAt: ASKED_AT });
    await scheduleRecipientFollowup(prismaWith(), { orderId: "o1", phoneNormalized: "+13105550100", sentAt: ASKED_AT });
    const keys = enqueue.mock.calls.map((c) => c[0].idempotencyKey);
    expect(new Set(keys).size).toBe(1);
  });
});

describe("волна 1 — переспросить получателя", () => {
  it("молчит → триггер повтора и запланированная волна 2 через 20 минут", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-04T18:00:00.000Z")); // 11:00 в LA

    await buildRecipientFollowupHandler(prismaWith())(record(1));

    expect(publishAutomationTrigger.mock.calls[0][1].triggerType).toBe("RECIPIENT_NO_REPLY");
    const next = enqueue.mock.calls[0][0];
    expect(next.idempotencyKey).toBe("recipient-followup:o1:2026-09-04:2");
    expect(next.payload.wave).toBe(2);
    expect(next.availableAt.getTime()).toBe(new Date("2026-09-04T18:00:00.000Z").getTime() + WAIT_AFTER_RETRY_MIN * 60_000);
  });

  it("ответил — ни повтора, ни волны 2: заказчика тревожить не за чем", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-04T18:00:00.000Z"));

    await buildRecipientFollowupHandler(prismaWith({ inboundFound: true }))(record(1));

    expect(publishAutomationTrigger).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe("волна 2 — сказать заказчику", () => {
  it("молчит → триггер заказчику и БОЛЬШЕ ничего не планируется", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-04T18:20:00.000Z"));

    await buildRecipientFollowupHandler(prismaWith())(record(2));

    expect(publishAutomationTrigger.mock.calls[0][1].triggerType).toBe("RECIPIENT_UNREACHABLE");
    expect(enqueue).not.toHaveBeenCalled(); // цепочка конечна: третьего сообщения нет
  });
});

describe("когда эскалация гаснет", () => {
  it("заказ доставлен — молчать уже нормально", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-04T18:00:00.000Z"));
    const prisma = prismaWith({ order: baseOrder({ orderStatus: "DELIVERED", deliveryStatus: "DELIVERED" }) });

    await buildRecipientFollowupHandler(prisma)(record(1));

    expect(publishAutomationTrigger).not.toHaveBeenCalled();
  });

  it("заказ отменён — не пишем ни получателю, ни заказчику", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-04T18:00:00.000Z"));
    const prisma = prismaWith({ order: baseOrder({ orderStatus: "CANCELLED" }) });

    await buildRecipientFollowupHandler(prisma)(record(1));

    expect(publishAutomationTrigger).not.toHaveBeenCalled();
  });

  it("вечер по времени магазина — переспрашивать поздно", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-05T04:00:00.000Z")); // 21:00 в Лос-Анджелесе

    await buildRecipientFollowupHandler(prismaWith())(record(1));

    expect(publishAutomationTrigger).not.toHaveBeenCalled();
  });

  it("доставку перенесли на другой день — волна прошлого дня уже никому не нужна", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-04T18:00:00.000Z"));
    const prisma = prismaWith({ order: baseOrder({ deliveryDate: new Date("2026-09-05T00:00:00.000Z") }) });

    await buildRecipientFollowupHandler(prisma)(record(1));

    expect(publishAutomationTrigger).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("сегодня не день доставки — эскалация живёт только в день приезда курьера", async () => {
    // Раньше это гарантировал сам триггер «Доставка сегодня». Теперь цепочку может завести любое
    // правило с галочкой, поэтому день проверяется в обработчике.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-03T18:00:00.000Z")); // 11:00 в LA, доставка завтра
    const prisma = prismaWith({ order: baseOrder(), automation: undefined });

    await buildRecipientFollowupHandler(prisma)(record(1, { deliveryDay: undefined }));

    expect(publishAutomationTrigger).not.toHaveBeenCalled();
  });

  it("владелец снял галочку — уже запланированные волны не доигрывают", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-04T18:00:00.000Z"));
    const prisma = prismaWith({ automation: { active: true, deletedAt: null, awaitRecipientReply: false } });

    await buildRecipientFollowupHandler(prisma)(record(1));

    expect(publishAutomationTrigger).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("правило выключено целиком — то же самое", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-04T18:00:00.000Z"));
    const prisma = prismaWith({ automation: { active: false, deletedAt: null, awaitRecipientReply: true } });

    await buildRecipientFollowupHandler(prisma)(record(1));

    expect(publishAutomationTrigger).not.toHaveBeenCalled();
  });

  it("волна без automationId (запланирована до правки) доигрывает как раньше", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-04T18:00:00.000Z"));
    const prisma = prismaWith();

    await buildRecipientFollowupHandler(prisma)(record(1, { automationId: undefined }));

    expect(publishAutomationTrigger).toHaveBeenCalledTimes(1);
    expect((prisma.automation.findUnique as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(0);
  });

  it("заказ исчез — обработчик молчит, а не падает", async () => {
    await buildRecipientFollowupHandler(prismaWith({ order: null }))(record(1));
    expect(publishAutomationTrigger).not.toHaveBeenCalled();
  });
});

describe("что считается ответом", () => {
  it("ищем по номеру получателя и только после вопроса", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-04T18:00:00.000Z"));
    const prisma = prismaWith();

    await buildRecipientFollowupHandler(prisma)(record(1));

    const where = (prisma.orderCommunication.findFirst as unknown as { mock: { calls: [{ where: Record<string, unknown> }][] } }).mock.calls[0][0].where;
    expect(where.direction).toBe("INBOUND");
    expect(where.externalPhoneNormalized).toBe("+13105550100");
    expect(where.occurredAt).toEqual({ gt: ASKED_AT });
    // Привязки к orderId быть НЕ должно: у двух похожих заказов на один номер входящее
    // остаётся несвязанным, и проверка по заказу дала бы ложное «молчит».
    expect(where).not.toHaveProperty("orderId");
  });
});
