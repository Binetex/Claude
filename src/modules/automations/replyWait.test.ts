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

import { scheduleReplyWait, buildReplyWaitHandler, WAIT_FIRST_MIN, WAIT_NEXT_MIN } from "./replyWait";
import { MAX_CHAIN_MESSAGES, chainOccurrenceKey } from "./chain";

/**
 * Ожидание ответа — общий механизм цепочек: правило отправило сообщение, ответа нет, запускается
 * следующее указанное правило. Тесты держат две вещи: цепочка идёт ровно один раз на каждое
 * отправленное сообщение и гаснет, как только продолжать незачем. Лишний шаг здесь — это SMS
 * живому человеку, а на шаге к заказчику ещё и тревога о заказе, с которым всё в порядке.
 */
const SENT_AT = new Date("2026-09-04T17:00:00.000Z"); // 10:00 в Лос-Анджелесе

const baseOrder = (over: Record<string, unknown> = {}) => ({
  id: "o1",
  siteId: "s1",
  orderStatus: "CONFIRMED",
  deliveryStatus: "PENDING",
  ...over,
});

function prismaWith(opts: {
  order?: Record<string, unknown> | null;
  /** Правило, отправившее сообщение: его ссылка «если не ответят» и состояние. */
  sender?: Record<string, unknown> | null;
  /** Правило, на которое ссылаются. */
  next?: Record<string, unknown> | null;
  inboundFound?: boolean;
  /** Сколько ШАГОВ цепочки уже создано по этому заказу. */
  chainSteps?: number;
  /** Другие адресаты того же сообщения (аудитория «Оба»). */
  siblingPhones?: string[];
} = {}): PrismaClient {
  const order = opts.order === undefined ? baseOrder() : opts.order;
  const sender =
    opts.sender === undefined ? { active: true, deletedAt: null, noReplyNextAutomationId: "a2" } : opts.sender;
  const next =
    opts.next === undefined ? { id: "a2", active: true, deletedAt: null, sites: [{ siteId: "s1" }] } : opts.next;

  const automationFindUnique = vi.fn().mockImplementation(({ where }: { where: { id: string } }) =>
    Promise.resolve(where.id === "a1" ? sender : next)
  );
  // Один findMany обслуживает два запроса обработчика: адресаты сообщения (по случаю) и уже
  // созданные шаги цепочки (distinct по occurrenceKey).
  const jobFindMany = vi.fn().mockImplementation((args: { distinct?: unknown[] }) =>
    Promise.resolve(
      args.distinct
        ? Array.from({ length: opts.chainSteps ?? 0 }, (_, i) => ({ occurrenceKey: `chain:x:o1:c${i}` }))
        : (opts.siblingPhones ?? []).map((phoneNormalized) => ({ phoneNormalized }))
    )
  );
  return {
    order: { findUnique: vi.fn().mockResolvedValue(order) },
    automation: { findUnique: automationFindUnique },
    automationJob: { findMany: jobFindMany },
    orderCommunication: { findFirst: vi.fn().mockResolvedValue(opts.inboundFound ? { id: "c1" } : null) },
  } as unknown as PrismaClient;
}

const record = (over: Record<string, unknown> = {}) => ({
  payload: {
    orderId: "o1",
    automationId: "a1",
    jobId: "job1",
    phoneNormalized: "+13105550100",
    askedAt: SENT_AT.toISOString(),
    senderCase: "o1:2026-09-04",
    dueAt: new Date(SENT_AT.getTime() + 60 * 60_000).toISOString(),
    ...over,
  },
});

beforeEach(() => {
  enqueue.mockReset();
  publishAutomationTrigger.mockReset();
});

describe("постановка ожидания", () => {
  it("без срока на правиле работает значение по умолчанию для первого сообщения", async () => {
    await scheduleReplyWait(prismaWith(), {
      orderId: "o1", automationId: "a1", jobId: "job1", phoneNormalized: "+13105550100", senderCase: "occ1", sentAt: SENT_AT, isChainStep: false,
    });

    const arg = enqueue.mock.calls[0][0];
    expect(arg.idempotencyKey).toBe("reply-wait:job1");
    expect(arg.availableAt.getTime()).toBe(SENT_AT.getTime() + 60 * 60_000);
  });

  it("сообщение, само пришедшее по цепочке, ждёт «следующим» сроком по умолчанию", async () => {
    await scheduleReplyWait(prismaWith(), {
      orderId: "o1", automationId: "a2", jobId: "job2", phoneNormalized: "+13105550100", senderCase: "occ1", sentAt: SENT_AT, isChainStep: true,
    });

    expect(enqueue.mock.calls[0][0].availableAt.getTime()).toBe(SENT_AT.getTime() + 20 * 60_000);
  });

  it("ключ привязан к ОТПРАВЛЕННОМУ сообщению — новое сообщение получает своё ожидание", async () => {
    // История: ключ был на заказ, и после переноса даты доставки вопрос уходил заново, а
    // ожидание молча не вставало — именно там, где получатель уже один раз не отозвался.
    const prisma = prismaWith();
    const common = { orderId: "o1", automationId: "a1", phoneNormalized: "+13105550100", senderCase: "occ1", sentAt: SENT_AT, isChainStep: false };
    await scheduleReplyWait(prisma, { ...common, jobId: "job1", senderCase: "o1:2026-09-04" });
    await scheduleReplyWait(prisma, { ...common, jobId: "job2", senderCase: "o1:2026-09-05" });

    expect(enqueue.mock.calls.map((c) => c[0].idempotencyKey)).toEqual(["reply-wait:job1", "reply-wait:job2"]);
  });

  it("без номера ожидание не ставится — отвечать некому", async () => {
    await scheduleReplyWait(prismaWith(), {
      orderId: "o1", automationId: "a1", jobId: "job1", phoneNormalized: null, senderCase: "occ1", sentAt: SENT_AT, isChainStep: false,
    });
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe("проверка ожидания", () => {
  it("молчат → запускается ИМЕННО указанное правило, случаем считается это сообщение", async () => {
    await buildReplyWaitHandler(prismaWith())(record());

    const arg = publishAutomationTrigger.mock.calls[0][1];
    expect(arg.automationId).toBe("a2");
    expect(arg.triggerType).toBe("CHAINED");
    expect(arg.occurrenceKey).toBe(chainOccurrenceKey({ nextAutomationId: "a2", orderId: "o1", senderCase: "o1:2026-09-04" }));
  });

  it("ответил — цепочка останавливается", async () => {
    await buildReplyWaitHandler(prismaWith({ inboundFound: true }))(record());
    expect(publishAutomationTrigger).not.toHaveBeenCalled();
  });

  it("ответ ищем по номеру и только после отправки", async () => {
    const prisma = prismaWith();
    await buildReplyWaitHandler(prisma)(record());

    const where = (prisma.orderCommunication.findFirst as unknown as { mock: { calls: [{ where: Record<string, unknown> }][] } }).mock.calls[0][0].where;
    expect(where.direction).toBe("INBOUND");
    expect(where.externalPhoneNormalized).toEqual({ in: ["+13105550100"] });
    expect(where.occurredAt).toEqual({ gt: SENT_AT });
    // Привязки к orderId быть НЕ должно: у двух похожих заказов на один номер входящее
    // остаётся несвязанным, и проверка по заказу дала бы ложное «молчит».
    expect(where).not.toHaveProperty("orderId");
  });
});

describe("когда цепочка гаснет", () => {
  it("владелец убрал ссылку — продолжения нет", async () => {
    await buildReplyWaitHandler(prismaWith({ sender: { noReplyNextAutomationId: null } }))(record());
    expect(publishAutomationTrigger).not.toHaveBeenCalled();
  });

  it("следующее правило выключено", async () => {
    await buildReplyWaitHandler(prismaWith({ next: { id: "a2", active: false, deletedAt: null, sites: [{ siteId: "s1" }] } }))(record());
    expect(publishAutomationTrigger).not.toHaveBeenCalled();
  });

  it("следующее правило не подключено к магазину заказа", async () => {
    await buildReplyWaitHandler(prismaWith({ next: { id: "a2", active: true, deletedAt: null, sites: [] } }))(record());
    expect(publishAutomationTrigger).not.toHaveBeenCalled();
  });

  it("заказ доставлен — молчать уже нормально", async () => {
    const prisma = prismaWith({ order: baseOrder({ orderStatus: "DELIVERED", deliveryStatus: "DELIVERED" }) });
    await buildReplyWaitHandler(prisma)(record());
    expect(publishAutomationTrigger).not.toHaveBeenCalled();
  });

  it("заказ отменён — не пишем никому", async () => {
    const prisma = prismaWith({ order: baseOrder({ orderStatus: "CANCELLED" }) });
    await buildReplyWaitHandler(prisma)(record());
    expect(publishAutomationTrigger).not.toHaveBeenCalled();
  });

  it("достигнут потолок сообщений цепочки на заказ — последний рубеж против кольца", async () => {
    const prisma = prismaWith({ chainSteps: MAX_CHAIN_MESSAGES });
    await buildReplyWaitHandler(prisma)(record());
    expect(publishAutomationTrigger).not.toHaveBeenCalled();
  });

  it("заказ исчез — обработчик молчит, а не падает", async () => {
    await buildReplyWaitHandler(prismaWith({ order: null }))(record());
    expect(publishAutomationTrigger).not.toHaveBeenCalled();
  });

  it("битая запись (нет правила в payload) игнорируется", async () => {
    await buildReplyWaitHandler(prismaWith())(record({ automationId: undefined }));
    expect(publishAutomationTrigger).not.toHaveBeenCalled();
  });
});

describe("аудитория «Оба» — двое адресатов у одного сообщения", () => {
  it("ответ ЛЮБОГО из них останавливает цепочку", async () => {
    // Правило пишет и заказчику, и получателю: ожидание ставится на каждое SMS. Раньше каждое
    // проверяло только СВОЙ номер, поэтому молчание одного отправляло продолжение и тому, кто
    // уже ответил.
    const prisma = prismaWith({ siblingPhones: ["+13105550100", "+13105550199"] });
    await buildReplyWaitHandler(prisma)(record());

    const where = (prisma.orderCommunication.findFirst as unknown as { mock: { calls: [{ where: Record<string, unknown> }][] } }).mock.calls[0][0].where;
    expect(where.externalPhoneNormalized).toEqual({ in: ["+13105550100", "+13105550199"] });
  });
});

describe("записи старого формата в очереди", () => {
  it("запись без jobId не доигрывается — иначе ушло бы не то сообщение и не тому", async () => {
    // Старая двухволновая эскалация клала в очередь {orderId, wave, askedAt, phoneNormalized}.
    // «Волна 2» означала шаг, который новая схема выражает ссылкой у ДРУГОГО правила: доиграв
    // её вслепую, мы повторили бы получателю тот же вопрос, а заказчик не получил бы ничего.
    const prisma = prismaWith();
    await buildReplyWaitHandler(prisma)({
      payload: { orderId: "o1", automationId: "a1", wave: 2, askedAt: SENT_AT.toISOString(), phoneNormalized: "+13105550100" },
    });

    expect(publishAutomationTrigger).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe("правило-отправитель", () => {
  it("выключено — цепочка не продолжается", async () => {
    const prisma = prismaWith({ sender: { active: false, deletedAt: null, noReplyNextAutomationId: "a2" } });
    await buildReplyWaitHandler(prisma)(record());
    expect(publishAutomationTrigger).not.toHaveBeenCalled();
  });

  it("удалено — цепочка не продолжается", async () => {
    const prisma = prismaWith({ sender: { active: true, deletedAt: new Date(), noReplyNextAutomationId: "a2" } });
    await buildReplyWaitHandler(prisma)(record());
    expect(publishAutomationTrigger).not.toHaveBeenCalled();
  });
});

describe("опоздавшая проверка", () => {
  it("воркер лежал сутки — накопленная проверка ничего не шлёт", async () => {
    // Проверки срабатывают пачкой, когда воркер поднимется. Сообщение «вы не ответили» через
    // сутки после вопроса человеку уже не нужно и читается как сбой.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(SENT_AT.getTime() + 25 * 60 * 60_000));

    await buildReplyWaitHandler(prismaWith())(record());

    expect(publishAutomationTrigger).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("небольшая задержка воркера цепочку не ломает", async () => {
    vi.useFakeTimers();
    // Срок был через час после отправки, проверка идёт на полчаса позже срока — это норма.
    vi.setSystemTime(new Date(SENT_AT.getTime() + 90 * 60_000));

    await buildReplyWaitHandler(prismaWith())(record());

    expect(publishAutomationTrigger).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("запись без срока считается по максимальной паузе от вопроса", async () => {
    // Такие записи могли попасть в очередь до появления поля: 12 часов паузы + допуск.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(SENT_AT.getTime() + 20 * 60 * 60_000));

    await buildReplyWaitHandler(prismaWith())(record({ dueAt: undefined }));

    expect(publishAutomationTrigger).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});

describe("срок ожидания берётся у правила, а не у магазина", () => {
  it("задан на правиле — ждём столько, сколько сказал владелец", async () => {
    // В лесенке из четырёх шагов у каждого своя пауза: вопросу хватает часа, напоминанию нужен день.
    await scheduleReplyWait(prismaWith(), {
      orderId: "o1", automationId: "a1", jobId: "job1", phoneNormalized: "+13105550100",
      senderCase: "occ1", sentAt: SENT_AT, isChainStep: true, ruleWaitMin: 2 * 24 * 60,
    });

    expect(enqueue.mock.calls[0][0].availableAt.getTime()).toBe(SENT_AT.getTime() + 2 * 24 * 60 * 60_000);
  });

  it("на правиле не задан — работает значение по умолчанию для шага цепочки", async () => {
    await scheduleReplyWait(prismaWith(), {
      orderId: "o1", automationId: "a1", jobId: "job1", phoneNormalized: "+13105550100",
      senderCase: "occ1", sentAt: SENT_AT, isChainStep: true, ruleWaitMin: null,
    });

    expect(enqueue.mock.calls[0][0].availableAt.getTime()).toBe(SENT_AT.getTime() + 20 * 60_000);
  });

  it("срок правила тоже режется границами", async () => {
    await scheduleReplyWait(prismaWith(), {
      orderId: "o1", automationId: "a1", jobId: "job1", phoneNormalized: "+13105550100",
      senderCase: "occ1", sentAt: SENT_AT, isChainStep: false, ruleWaitMin: 1,
    });

    expect(enqueue.mock.calls[0][0].availableAt.getTime()).toBe(SENT_AT.getTime() + 5 * 60_000);
  });
});
