import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Юнит-тесты логики OCC/аудита сервиса updateOrderBlock на мокнутом Prisma (без БД).
 * Проверяют ветвление: успех пишет аудит только по изменённым полям; конфликт (count=0)
 * возвращает свежие значения и НЕ пишет аудит и НЕ перезаписывает; обновляются только поля
 * блока; нормализация телефона; валидация статуса. Реальную гонку двух транзакций проверяет
 * updateOrderBlock.integration.test.ts (на живой БД).
 */

const tx = {
  order: { findUnique: vi.fn(), updateMany: vi.fn() },
  orderAudit: { create: vi.fn() },
};
const $transaction = vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx));

vi.mock("@/lib/db", () => ({ prisma: { $transaction: (fn: (t: typeof tx) => unknown) => $transaction(fn) } }));

import { updateOrderBlock } from "./updateOrderBlock";

const EXPECTED = "2026-07-21T10:00:00.000Z";
const NEW_TS = new Date("2026-07-21T12:00:00.000Z");

beforeEach(() => {
  tx.order.findUnique.mockReset();
  tx.order.updateMany.mockReset();
  tx.orderAudit.create.mockReset();
  $transaction.mockClear();
  tx.orderAudit.create.mockResolvedValue({});
});

describe("updateOrderBlock — успех (контакты, роль CALL_CENTER)", () => {
  it("обновляет только поля блока и пишет аудит только по изменённым полям", async () => {
    const before = { recipientName: "Old", recipientPhone: "+13105550001", recipientEmail: null, addressLine: "1 St", apartment: null, city: "Austin", zip: "78701" };
    const after = { ...before, recipientName: "New Name", updatedAt: NEW_TS };
    tx.order.findUnique.mockResolvedValueOnce(before).mockResolvedValueOnce(after);
    tx.order.updateMany.mockResolvedValueOnce({ count: 1 });

    const res = await updateOrderBlock({
      orderId: "o1", block: "contacts", expectedUpdatedAt: EXPECTED,
      data: { recipientName: "New Name", recipientPhone: "+13105550001", recipientEmail: "", addressLine: "1 St", apartment: "", city: "Austin", zip: "78701" },
      actor: { userId: "u-cc", role: "CALL_CENTER" },
    });

    expect(res).toEqual({ status: "ok", updatedAt: NEW_TS.toISOString(), changed: { recipientName: { from: "Old", to: "New Name" } } });

    // OCC: updateMany строго по id + ожидаемой версии.
    const where = tx.order.updateMany.mock.calls[0][0].where;
    expect(where).toEqual({ id: "o1", updatedAt: new Date(EXPECTED) });

    // Обновляются ТОЛЬКО поля блока «contacts» — никаких status/cardMessage/delivery.
    const data = tx.order.updateMany.mock.calls[0][0].data;
    expect(Object.keys(data).sort()).toEqual(["addressLine", "apartment", "city", "recipientEmail", "recipientName", "recipientPhone", "zip"]);

    // Аудит: та же транзакция, блок/роль/только изменённые поля.
    expect(tx.orderAudit.create).toHaveBeenCalledTimes(1);
    expect(tx.orderAudit.create.mock.calls[0][0].data).toMatchObject({
      orderId: "o1", userId: "u-cc", role: "CALL_CENTER", block: "contacts",
      changed: { recipientName: { from: "Old", to: "New Name" } },
    });
  });
});

describe("updateOrderBlock — florist меняет дату и статус", () => {
  it("статус (роль FLORIST) — ок", async () => {
    tx.order.findUnique.mockResolvedValueOnce({ orderStatus: "CONFIRMED" }).mockResolvedValueOnce({ orderStatus: "READY", updatedAt: NEW_TS });
    tx.order.updateMany.mockResolvedValueOnce({ count: 1 });
    const res = await updateOrderBlock({ orderId: "o1", block: "status", expectedUpdatedAt: EXPECTED, data: { orderStatus: "READY" }, actor: { userId: "u-f", role: "FLORIST" } });
    expect(res.status).toBe("ok");
    expect(tx.order.updateMany.mock.calls[0][0].data).toEqual({ orderStatus: "READY" });
    expect(tx.orderAudit.create.mock.calls[0][0].data).toMatchObject({ role: "FLORIST", block: "status", changed: { orderStatus: { from: "CONFIRMED", to: "READY" } } });
  });

  it("дата доставки — строка приводится к Date", async () => {
    tx.order.findUnique.mockResolvedValueOnce({ deliveryDate: new Date("2026-07-20T00:00:00.000Z"), deliveryWindow: "10-12" }).mockResolvedValueOnce({ deliveryDate: new Date("2026-07-22T00:00:00.000Z"), deliveryWindow: "12-16", updatedAt: NEW_TS });
    tx.order.updateMany.mockResolvedValueOnce({ count: 1 });
    const res = await updateOrderBlock({ orderId: "o1", block: "delivery", expectedUpdatedAt: EXPECTED, data: { deliveryDate: "2026-07-22", deliveryWindow: "12-16" }, actor: { userId: "u-f", role: "FLORIST" } });
    expect(res.status).toBe("ok");
    expect(tx.order.updateMany.mock.calls[0][0].data.deliveryDate).toBeInstanceOf(Date);
    expect(tx.order.updateMany.mock.calls[0][0].data.deliveryWindow).toBe("12-16");
  });
});

describe("updateOrderBlock — нормализация телефона (sender)", () => {
  it("телефон без + получает код страны", async () => {
    tx.order.findUnique.mockResolvedValueOnce({ senderName: "A", senderPhone: "+13105550000", senderEmail: null }).mockResolvedValueOnce({ senderName: "A", senderPhone: "+13105551234", senderEmail: null, updatedAt: NEW_TS });
    tx.order.updateMany.mockResolvedValueOnce({ count: 1 });
    await updateOrderBlock({ orderId: "o1", block: "sender", expectedUpdatedAt: EXPECTED, data: { senderName: "A", senderPhone: "3105551234" }, actor: { userId: "u", role: "OWNER" } });
    expect(tx.order.updateMany.mock.calls[0][0].data.senderPhone).toBe("+13105551234");
  });
});

describe("updateOrderBlock — конфликт версий (OCC)", () => {
  it("count=0 → CONFLICT: свежие значения из БД, БЕЗ аудита и БЕЗ перезаписи", async () => {
    const before = { orderStatus: "CONFIRMED" };
    const fresh = { orderStatus: "IN_PROGRESS", updatedAt: NEW_TS }; // другой пользователь уже поменял
    tx.order.findUnique.mockResolvedValueOnce(before).mockResolvedValueOnce(fresh);
    tx.order.updateMany.mockResolvedValueOnce({ count: 0 });

    const res = await updateOrderBlock({ orderId: "o1", block: "status", expectedUpdatedAt: EXPECTED, data: { orderStatus: "READY" }, actor: { userId: "u", role: "CALL_CENTER" } });

    expect(res).toEqual({ status: "conflict", current: { orderStatus: "IN_PROGRESS" }, updatedAt: NEW_TS.toISOString() });
    expect(tx.orderAudit.create).not.toHaveBeenCalled(); // нет аудита при конфликте
  });
});

describe("updateOrderBlock — валидация", () => {
  it("недопустимый статус → invalid, транзакция не открывается", async () => {
    const res = await updateOrderBlock({ orderId: "o1", block: "status", expectedUpdatedAt: EXPECTED, data: { orderStatus: "AWAITING_PAYMENT" }, actor: { userId: "u", role: "OWNER" } });
    expect(res.status).toBe("invalid");
    expect($transaction).not.toHaveBeenCalled();
  });

  it("несуществующий заказ → notfound", async () => {
    tx.order.findUnique.mockResolvedValueOnce(null);
    const res = await updateOrderBlock({ orderId: "nope", block: "status", expectedUpdatedAt: EXPECTED, data: { orderStatus: "READY" }, actor: { userId: "u", role: "OWNER" } });
    expect(res.status).toBe("notfound");
    expect(tx.order.updateMany).not.toHaveBeenCalled();
  });
});
