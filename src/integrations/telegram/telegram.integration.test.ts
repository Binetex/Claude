/**
 * Интеграция внутренних Telegram-уведомлений на реальной БД (throwaway prisma dev).
 * Обработчик прогоняется напрямую — worker лишь диспетчеризует по eventType. Сеть замокана.
 *
 * Главное, что здесь проверяется и не покрывается юнитами: у каждого флориста СВОЙ бот, и
 * сообщение редактируется тем же ботом, который его отправил. Передача заказа — это два
 * разных бота и два разных сообщения, а не одно отредактированное.
 */
import { describe, it, expect, afterAll, beforeEach, vi } from "vitest";
import { prisma } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import type { OutboxRecord } from "@/outbox/types";

const suffix = `tgit-${Date.now()}`;
const createdSiteIds: string[] = [];
const createdOrderIds: string[] = [];
const createdUserIds: string[] = [];
const createdFloristIds: string[] = [];

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);
const reply = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });
const okSend = (id = 111) => reply({ ok: true, result: { message_id: id } });
const okEdit = () => reply({ ok: true, result: {} });

// Реальный secretBox требует ключ; для теста задаём детерминированный.
process.env.CREDENTIALS_ENCRYPTION_KEY ||= Buffer.alloc(32, 7).toString("base64");

const { buildTelegramNotifyHandler } = await import("./handler");
const { encryptSecret } = await import("@/lib/crypto/secretBox");
const handler = buildTelegramNotifyHandler(prisma);

function rec(payload: unknown): OutboxRecord {
  return {
    id: "evt", eventType: "telegram.notify", aggregateType: "order", aggregateId: "o", payload,
    idempotencyKey: `k-${Math.random()}`, status: "PROCESSING", attempts: 0, maxAttempts: 8,
    availableAt: new Date(), lockedAt: new Date(), lockedBy: "test", processedAt: null,
    lastError: null, createdAt: new Date(), updatedAt: new Date(),
  };
}

async function enableGlobally(enabled = true) {
  await prisma.telegramSettings.upsert({
    where: { id: "singleton" },
    create: { id: "singleton", enabled },
    update: { enabled },
  });
}

async function makeSite() {
  const site = await prisma.site.create({
    data: { name: `TG ${suffix}`, shortName: `TG${createdSiteIds.length}`, platform: "SHOPIFY", timezone: "America/Los_Angeles" },
  });
  createdSiteIds.push(site.id);
  return site;
}

async function makeFlorist(name: string, opts: { chatId?: string; enabled?: boolean; withBot?: boolean } = {}) {
  const user = await prisma.user.create({
    data: { name, email: `${name}-${suffix}@t.local`, role: "FLORIST", passwordHash: "x" },
  });
  createdUserIds.push(user.id);
  const florist = await prisma.florist.create({ data: { userId: user.id } });
  createdFloristIds.push(florist.id);
  if (opts.withBot !== false) {
    await prisma.telegramBot.create({
      data: {
        label: name, purpose: "FLORIST", floristId: florist.id,
        tokenEncrypted: encryptSecret(`token-${name}`),
        chatId: opts.chatId ?? `100${createdFloristIds.length}`,
        enabled: opts.enabled ?? true,
        verifiedAt: new Date(),
      },
    });
  }
  return florist;
}

async function makeOwnerBot() {
  const existing = await prisma.telegramBot.findFirst({ where: { purpose: "OWNER" } });
  if (existing) return existing;
  return prisma.telegramBot.create({
    data: { label: "Владелец", purpose: "OWNER", tokenEncrypted: encryptSecret("token-owner"), chatId: "-100owner", enabled: true, verifiedAt: new Date() },
  });
}

async function makeOrder(siteId: string) {
  const order = await prisma.order.create({
    data: {
      orderNumber: `TG-${createdOrderIds.length}-${suffix}`,
      site: { connect: { id: siteId } },
      platform: "SHOPIFY", source: "Test",
      externalCreatedAt: new Date(), deliveryDate: new Date(), deliveryWindow: "12:00 – 16:00",
      senderName: "Anna", senderPhone: "+13105550000",
      recipientName: "Ann Recipient", recipientPhone: "+13105550001",
      addressLine: "1 Main St", city: "LA", zip: "90001",
      itemsTotal: new Prisma.Decimal(100), customerTotal: new Prisma.Decimal(100),
      items: { create: [{ name: "Roses", variantName: "Standard", quantity: 1, externalPrice: new Prisma.Decimal(100), floristCompositionSnapshot: "24 roses" }] },
    },
  });
  createdOrderIds.push(order.id);
  return order;
}

const tgMessages = (orderId: string) => prisma.telegramMessage.findMany({ where: { orderId }, orderBy: { createdAt: "asc" } });
/** Токен, которым реально сходили в Telegram — вытаскиваем из URL вызова. */
const tokenOfCall = (i: number) => String(fetchMock.mock.calls[i][0]).match(/\/bot([^/]+)\//)?.[1];

beforeEach(async () => {
  fetchMock.mockReset();
  await enableGlobally(true);
});

afterAll(async () => {
  await prisma.telegramMessage.deleteMany({ where: { orderId: { in: createdOrderIds } } });
  await prisma.orderItem.deleteMany({ where: { orderId: { in: createdOrderIds } } });
  await prisma.order.deleteMany({ where: { id: { in: createdOrderIds } } });
  await prisma.telegramBot.deleteMany({ where: { OR: [{ floristId: { in: createdFloristIds } }, { purpose: "OWNER" }] } });
  await prisma.florist.deleteMany({ where: { id: { in: createdFloristIds } } });
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await prisma.site.deleteMany({ where: { id: { in: createdSiteIds } } });
  await prisma.$disconnect();
});

describe("персональные боты флористов", () => {
  it("назначение → сообщение ботом ЭТОГО флориста в ЕГО чат", async () => {
    const site = await makeSite();
    const natasha = await makeFlorist("Наташа", { chatId: "111" });
    const order = await makeOrder(site.id);
    fetchMock.mockResolvedValueOnce(okSend(501));

    await handler(rec({ type: "order.assigned", orderId: order.id, floristId: natasha.id, context: { floristName: "Наташа" } }));

    const rows = await tgMessages(order.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ chatId: "111", messageId: "501", audience: "FLORIST" });
    expect(rows[0].dedupeKey).toBe(`order:${order.id}:florist:${natasha.id}`);
    expect(tokenOfCall(0)).toBe("token-Наташа"); // именно её токен
  });

  it("у двух флористов по своему сообщению — ключи не сталкиваются", async () => {
    const site = await makeSite();
    const a = await makeFlorist("Флорист-A", { chatId: "201" });
    const b = await makeFlorist("Флорист-B", { chatId: "202" });
    const order = await makeOrder(site.id);
    fetchMock.mockResolvedValueOnce(okSend(601)).mockResolvedValueOnce(okSend(602));

    await handler(rec({ type: "order.assigned", orderId: order.id, floristId: a.id, context: { floristName: "Флорист-A" } }));
    await handler(rec({ type: "order.assigned", orderId: order.id, floristId: b.id, context: { floristName: "Флорист-B" } }));

    const rows = await tgMessages(order.id);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.chatId).sort()).toEqual(["201", "202"]);
  });

  it("ПЕРЕДАЧА: прежнему правится его сообщение ЕГО ботом, новому уходит новое", async () => {
    const site = await makeSite();
    const from = await makeFlorist("Отдающий", { chatId: "301" });
    const to = await makeFlorist("Принимающий", { chatId: "302" });
    const order = await makeOrder(site.id);
    fetchMock
      .mockResolvedValueOnce(okSend(701)) // назначение прежнему
      .mockResolvedValueOnce(okSend(702)) // новое сообщение принимающему
      .mockResolvedValueOnce(okEdit());   // правка сообщения отдающего

    await handler(rec({ type: "order.assigned", orderId: order.id, floristId: from.id, context: { floristName: "Отдающий" } }));
    await handler(rec({ type: "order.assigned", orderId: order.id, floristId: to.id, context: { floristName: "Принимающий" } }));
    await handler(rec({ type: "order.handed_over", orderId: order.id, floristId: from.id, context: { toFloristName: "Принимающий" } }));

    const rows = await tgMessages(order.id);
    expect(rows).toHaveLength(2); // по одному на флориста, дублей нет

    const oldMsg = rows.find((r) => r.chatId === "301")!;
    expect(oldMsg.messageId).toBe("701");              // сообщение то же самое
    expect(oldMsg.eventType).toBe("order.handed_over");
    expect(oldMsg.lastText).toContain("передан");
    // Правка ушла токеном ОТДАЮЩЕГО — чужим ботом Telegram бы не дал.
    expect(String(fetchMock.mock.calls[2][0])).toContain("editMessageText");
    expect(tokenOfCall(2)).toBe("token-Отдающий");

    const newMsg = rows.find((r) => r.chatId === "302")!;
    expect(newMsg.messageId).toBe("702");
    expect(newMsg.lastText).toContain("Новый заказ");
  });

  it("у флориста нет бота → тихий пропуск, сети нет", async () => {
    const site = await makeSite();
    const noBot = await makeFlorist("Без-бота", { withBot: false });
    const order = await makeOrder(site.id);

    await expect(handler(rec({ type: "order.assigned", orderId: order.id, floristId: noBot.id }))).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await tgMessages(order.id)).toHaveLength(0);
  });

  it("бот выключен → тихий пропуск", async () => {
    const site = await makeSite();
    const off = await makeFlorist("Выключенный", { enabled: false });
    const order = await makeOrder(site.id);

    await expect(handler(rec({ type: "order.assigned", orderId: order.id, floristId: off.id }))).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("повторное событие с тем же текстом → в Telegram не ходим", async () => {
    const site = await makeSite();
    const f = await makeFlorist("Повтор", { chatId: "401" });
    const order = await makeOrder(site.id);
    fetchMock.mockResolvedValueOnce(okSend(801));
    const payload = { type: "order.assigned", orderId: order.id, floristId: f.id, context: { floristName: "Повтор" } };

    await handler(rec(payload));
    await handler(rec(payload));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await tgMessages(order.id)).toHaveLength(1);
  });

  it("сообщение удалено в Telegram → новое тем же ботом, messageId обновлён", async () => {
    const site = await makeSite();
    const f = await makeFlorist("Удалённое", { chatId: "501" });
    const order = await makeOrder(site.id);
    fetchMock
      .mockResolvedValueOnce(okSend(901))
      .mockResolvedValueOnce(reply({ ok: false, error_code: 400, description: "Bad Request: message to edit not found" }, 400))
      .mockResolvedValueOnce(okSend(999));

    await handler(rec({ type: "order.assigned", orderId: order.id, floristId: f.id, context: { floristName: "Удалённое" } }));
    await handler(rec({ type: "order.handed_over", orderId: order.id, floristId: f.id, context: { toFloristName: "Кто-то" } }));

    const rows = await tgMessages(order.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].messageId).toBe("999");
  });
});

describe("уведомления владельца", () => {
  it("новый заказ, проблема оплаты и проблема доставки — три независимых сообщения", async () => {
    await makeOwnerBot();
    const site = await makeSite();
    const order = await makeOrder(site.id);
    fetchMock.mockResolvedValueOnce(okSend(1001)).mockResolvedValueOnce(okSend(1002)).mockResolvedValueOnce(okSend(1003));

    await handler(rec({ type: "order.created", orderId: order.id, context: { paymentLabel: "UNPAID" } }));
    await handler(rec({ type: "payment.failed", orderId: order.id, context: { safeReason: "отклонён" } }));
    await handler(rec({ type: "delivery.problem", orderId: order.id, context: { status: "FAILED" } }));

    const rows = await tgMessages(order.id);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.chatId === "-100owner")).toBe(true);
    expect(tokenOfCall(0)).toBe("token-owner");
  });
});

describe("устойчивость", () => {
  it("общий выключатель → ничего не отправляется", async () => {
    await makeOwnerBot();
    const site = await makeSite();
    const order = await makeOrder(site.id);
    await enableGlobally(false);

    await expect(handler(rec({ type: "order.created", orderId: order.id }))).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("временная ошибка Telegram → бросаем, outbox повторит", async () => {
    const site = await makeSite();
    const f = await makeFlorist("Сбой", { chatId: "601" });
    const order = await makeOrder(site.id);
    fetchMock.mockResolvedValue(reply({ ok: false, error_code: 500 }, 500));

    await expect(handler(rec({ type: "order.assigned", orderId: order.id, floristId: f.id }))).rejects.toThrow(/telegram_send_transient/);
    expect(await tgMessages(order.id)).toHaveLength(0);
  });

  it("постоянная ошибка Telegram не роняет обработчик", async () => {
    const site = await makeSite();
    const f = await makeFlorist("Заблокирован", { chatId: "701" });
    const order = await makeOrder(site.id);
    fetchMock.mockResolvedValue(reply({ ok: false, error_code: 403, description: "bot was blocked" }, 403));

    await expect(handler(rec({ type: "order.assigned", orderId: order.id, floristId: f.id }))).resolves.toBeUndefined();
    expect(await tgMessages(order.id)).toHaveLength(0);
  });
});
