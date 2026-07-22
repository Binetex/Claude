/**
 * Интеграция внутренних Telegram-уведомлений на реальной БД (throwaway prisma dev).
 * Обработчик прогоняется напрямую — worker лишь диспетчеризует по eventType. Сеть замокана:
 * проверяем ровно то, что нельзя проверить юнитом — идемпотентность через unique dedupeKey,
 * выбор между send и edit, и что сбой Telegram не роняет обработку.
 */
import { describe, it, expect, afterAll, beforeEach, vi } from "vitest";
import { prisma } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import type { OutboxRecord } from "@/outbox/types";

const suffix = `tgit-${Date.now()}`;
const createdSiteIds: string[] = [];
const createdOrderIds: string[] = [];

// Конфигурация до импорта обработчика: он читает env через getTelegramConfig при каждом вызове.
process.env.TELEGRAM_ENABLED = "true";
process.env.TELEGRAM_BOT_TOKEN = "test-token";
process.env.TELEGRAM_CHAT_ID_OWNER = "-100owner";
process.env.TELEGRAM_CHAT_ID_FLORISTS = "-100florists";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);
const reply = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });
const okSend = (id = 111) => reply({ ok: true, result: { message_id: id } });
const okEdit = () => reply({ ok: true, result: {} });

const { buildTelegramNotifyHandler } = await import("./handler");
const handler = buildTelegramNotifyHandler(prisma);

function rec(payload: unknown): OutboxRecord {
  return {
    id: "evt", eventType: "telegram.notify", aggregateType: "order", aggregateId: "o", payload,
    idempotencyKey: `k-${Math.random()}`, status: "PROCESSING", attempts: 0, maxAttempts: 8,
    availableAt: new Date(), lockedAt: new Date(), lockedBy: "test", processedAt: null,
    lastError: null, createdAt: new Date(), updatedAt: new Date(),
  };
}

async function makeSite() {
  const site = await prisma.site.create({
    data: { name: `TG ${suffix}`, shortName: `TG${createdSiteIds.length}`, platform: "SHOPIFY", timezone: "America/Los_Angeles" },
  });
  createdSiteIds.push(site.id);
  return site;
}

async function makeOrder(siteId: string) {
  const order = await prisma.order.create({
    data: {
      orderNumber: `TG-${createdOrderIds.length}-${suffix}`,
      site: { connect: { id: siteId } },
      platform: "SHOPIFY",
      source: "Test",
      externalCreatedAt: new Date(),
      deliveryDate: new Date(),
      deliveryWindow: "12:00 – 16:00",
      senderName: "Anna",
      senderPhone: "+13105550000",
      recipientName: "Ann Recipient",
      recipientPhone: "+13105550001",
      addressLine: "1 Main St",
      city: "LA",
      zip: "90001",
      itemsTotal: new Prisma.Decimal(100),
      customerTotal: new Prisma.Decimal(100),
      items: { create: [{ name: "Roses", variantName: "Standard", quantity: 1, externalPrice: new Prisma.Decimal(100), floristCompositionSnapshot: "24 roses" }] },
    },
  });
  createdOrderIds.push(order.id);
  return order;
}

const tgMessages = (orderId: string) => prisma.telegramMessage.findMany({ where: { orderId } });

beforeEach(() => fetchMock.mockReset());

afterAll(async () => {
  await prisma.telegramMessage.deleteMany({ where: { orderId: { in: createdOrderIds } } });
  await prisma.orderItem.deleteMany({ where: { orderId: { in: createdOrderIds } } });
  await prisma.order.deleteMany({ where: { id: { in: createdOrderIds } } });
  await prisma.site.deleteMany({ where: { id: { in: createdSiteIds } } });
  await prisma.$disconnect();
});

describe("назначение флориста", () => {
  it("1. новое назначение → отправляется сообщение и сохраняется messageId", async () => {
    const site = await makeSite();
    const order = await makeOrder(site.id);
    fetchMock.mockResolvedValueOnce(okSend(501));

    await handler(rec({ type: "order.assigned", orderId: order.id, context: { floristName: "Наташа" } }));

    const rows = await tgMessages(order.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ dedupeKey: `order:${order.id}:florist`, audience: "FLORIST", chatId: "-100florists", messageId: "501" });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).text).toContain(order.orderNumber);
  });

  it("2. повторное событие с тем же текстом → в Telegram не ходим вовсе, дубля нет", async () => {
    const site = await makeSite();
    const order = await makeOrder(site.id);
    fetchMock.mockResolvedValueOnce(okSend(502));
    const payload = { type: "order.assigned", orderId: order.id, context: { floristName: "Наташа" } };

    await handler(rec(payload));
    await handler(rec(payload)); // повторный webhook/sync

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await tgMessages(order.id)).toHaveLength(1);
  });

  it("3. передача другому флористу → editMessage существующего, а не новое сообщение", async () => {
    const site = await makeSite();
    const order = await makeOrder(site.id);
    fetchMock.mockResolvedValueOnce(okSend(503)).mockResolvedValueOnce(okEdit());

    await handler(rec({ type: "order.assigned", orderId: order.id, context: { floristName: "Наташа" } }));
    await handler(rec({ type: "order.reassigned", orderId: order.id, context: { floristName: "Пётр" } }));

    expect(fetchMock.mock.calls[1][0]).toContain("editMessageText");
    const rows = await tgMessages(order.id);
    expect(rows).toHaveLength(1); // то же сообщение, messageId не менялся
    expect(rows[0].messageId).toBe("503");
    expect(rows[0].lastText).toContain("передан");
  });

  it("10. сообщение удалено в Telegram → отправляем новое и обновляем messageId", async () => {
    const site = await makeSite();
    const order = await makeOrder(site.id);
    fetchMock
      .mockResolvedValueOnce(okSend(504))
      .mockResolvedValueOnce(reply({ ok: false, error_code: 400, description: "Bad Request: message to edit not found" }, 400))
      .mockResolvedValueOnce(okSend(999));

    await handler(rec({ type: "order.assigned", orderId: order.id, context: { floristName: "Наташа" } }));
    await handler(rec({ type: "order.reassigned", orderId: order.id, context: { floristName: "Пётр" } }));

    const rows = await tgMessages(order.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].messageId).toBe("999");
  });
});

describe("уведомления владельца", () => {
  it("4. новый заказ → отдельное сообщение в чат владельца", async () => {
    const site = await makeSite();
    const order = await makeOrder(site.id);
    fetchMock.mockResolvedValueOnce(okSend(601));

    await handler(rec({ type: "order.created", orderId: order.id, context: { paymentLabel: "UNPAID" } }));

    const rows = await tgMessages(order.id);
    expect(rows[0]).toMatchObject({ dedupeKey: `order:${order.id}:owner`, audience: "OWNER", chatId: "-100owner" });
    expect(rows[0].lastText).toContain("UNPAID");
  });

  it("5+6. проблема оплаты и проблема доставки НЕ затирают сообщение о новом заказе", async () => {
    const site = await makeSite();
    const order = await makeOrder(site.id);
    fetchMock.mockResolvedValueOnce(okSend(602)).mockResolvedValueOnce(okSend(603)).mockResolvedValueOnce(okSend(604));

    await handler(rec({ type: "order.created", orderId: order.id, context: { paymentLabel: "UNPAID" } }));
    await handler(rec({ type: "payment.pending", orderId: order.id, context: { safeReason: "платёж отклонён" } }));
    await handler(rec({ type: "delivery.problem", orderId: order.id, context: { status: "FAILED", safeReason: "courier failed" } }));

    const rows = await tgMessages(order.id);
    expect(rows).toHaveLength(3); // три независимых сообщения, каждое со своим dedupeKey
    expect(rows.map((r) => r.messageId).sort()).toEqual(["602", "603", "604"]);
  });
});

describe("устойчивость", () => {
  it("7. временная ошибка Telegram → бросаем, чтобы outbox повторил", async () => {
    const site = await makeSite();
    const order = await makeOrder(site.id);
    fetchMock.mockResolvedValue(reply({ ok: false, error_code: 500 }, 500));

    await expect(handler(rec({ type: "order.created", orderId: order.id }))).rejects.toThrow(/telegram_send_transient/);
    expect(await tgMessages(order.id)).toHaveLength(0);
  });

  it("8. постоянная ошибка Telegram НЕ роняет обработчик", async () => {
    const site = await makeSite();
    const order = await makeOrder(site.id);
    fetchMock.mockResolvedValue(reply({ ok: false, error_code: 403, description: "bot was blocked" }, 403));

    await expect(handler(rec({ type: "order.created", orderId: order.id }))).resolves.toBeUndefined();
    expect(await tgMessages(order.id)).toHaveLength(0);
  });

  it("нет chatId для аудитории → событие безопасно пропускается, сети нет", async () => {
    const site = await makeSite();
    const order = await makeOrder(site.id);
    const saved = process.env.TELEGRAM_CHAT_ID_FLORISTS;
    process.env.TELEGRAM_CHAT_ID_FLORISTS = "";
    try {
      await expect(handler(rec({ type: "order.assigned", orderId: order.id }))).resolves.toBeUndefined();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(await tgMessages(order.id)).toHaveLength(0);
    } finally {
      process.env.TELEGRAM_CHAT_ID_FLORISTS = saved;
    }
  });

  it("интеграция выключена → ничего не отправляется", async () => {
    const site = await makeSite();
    const order = await makeOrder(site.id);
    process.env.TELEGRAM_ENABLED = "false";
    try {
      await expect(handler(rec({ type: "order.created", orderId: order.id }))).resolves.toBeUndefined();
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      process.env.TELEGRAM_ENABLED = "true";
    }
  });
});
