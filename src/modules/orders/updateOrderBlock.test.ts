import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Юнит-тесты сервиса updateOrderBlock на мокнутом Prisma (без БД): успех пишет аудит только по
 * изменённым полям; обновляются только присланные поля блока, строго по id — без сверки версии
 * заказа; нормализация телефона; валидация статуса.
 */

const tx = {
  order: { findUnique: vi.fn(), update: vi.fn() },
  orderAudit: { create: vi.fn() },
};
const $transaction = vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx));

vi.mock("@/lib/db", () => ({ prisma: { $transaction: (fn: (t: typeof tx) => unknown) => $transaction(fn) } }));

import { updateOrderBlock } from "./updateOrderBlock";


beforeEach(() => {
  tx.order.findUnique.mockReset();
  tx.order.update.mockReset();
  tx.orderAudit.create.mockReset();
  $transaction.mockClear();
  tx.orderAudit.create.mockResolvedValue({});
});

describe("updateOrderBlock — успех (контакты, роль CALL_CENTER)", () => {
  it("обновляет только поля блока и пишет аудит только по изменённым полям", async () => {
    const before = { recipientName: "Old", recipientPhone: "+13105550001", recipientEmail: null, addressLine: "1 St", apartment: null, city: "Austin", zip: "78701" };
    const after = { ...before, recipientName: "New Name" };
    tx.order.findUnique.mockResolvedValueOnce(before);
    tx.order.update.mockResolvedValueOnce(after);

    const res = await updateOrderBlock({
      orderId: "o1", block: "contacts",
      data: { recipientName: "New Name", recipientPhone: "+13105550001", recipientEmail: "", addressLine: "1 St", apartment: "", city: "Austin", zip: "78701" },
      actor: { userId: "u-cc", role: "CALL_CENTER" },
    });

    expect(res).toEqual({ status: "ok", changed: { recipientName: { from: "Old", to: "New Name" } } });

    // Строго по id: версии заказа больше нет — её сдвигала сама система, и сохранение
    // кончалось ложным «изменён другим пользователем» (владелец 07.10.2026).
    const where = tx.order.update.mock.calls[0][0].where;
    expect(where).toEqual({ id: "o1" });

    // Обновляются ТОЛЬКО поля блока «contacts» — никаких status/cardMessage/delivery.
    const data = tx.order.update.mock.calls[0][0].data;
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
    tx.order.findUnique.mockResolvedValueOnce({ orderStatus: "CONFIRMED" });
    tx.order.update.mockResolvedValueOnce({ orderStatus: "READY" });
    const res = await updateOrderBlock({ orderId: "o1", block: "status", data: { orderStatus: "READY" }, actor: { userId: "u-f", role: "FLORIST" } });
    expect(res.status).toBe("ok");
    expect(tx.order.update.mock.calls[0][0].data).toEqual({ orderStatus: "READY" });
    expect(tx.orderAudit.create.mock.calls[0][0].data).toMatchObject({ role: "FLORIST", block: "status", changed: { orderStatus: { from: "CONFIRMED", to: "READY" } } });
  });

  it("дата доставки — строка приводится к Date", async () => {
    tx.order.findUnique.mockResolvedValueOnce({ deliveryDate: new Date("2026-07-20T00:00:00.000Z"), deliveryWindow: "10-12" });
    tx.order.update.mockResolvedValueOnce({ deliveryDate: new Date("2026-07-22T00:00:00.000Z"), deliveryWindow: "12-16" });
    const res = await updateOrderBlock({ orderId: "o1", block: "delivery", data: { deliveryDate: "2026-07-22", deliveryWindow: "12-16" }, actor: { userId: "u-f", role: "FLORIST" } });
    expect(res.status).toBe("ok");
    expect(tx.order.update.mock.calls[0][0].data.deliveryDate).toBeInstanceOf(Date);
    // Окно строго «с — до»: текст разобран в числа и записан системой одним форматом.
    expect(tx.order.update.mock.calls[0][0].data.deliveryWindow).toBe("12:00 - 16:00");
    expect(tx.order.update.mock.calls[0][0].data.windowFrom).toBe(720);
    expect(tx.order.update.mock.calls[0][0].data.windowTo).toBe(960);
  });
});

describe("updateOrderBlock — нормализация телефона (sender)", () => {
  it("телефон без + получает код страны", async () => {
    tx.order.findUnique.mockResolvedValueOnce({ senderName: "A", senderPhone: "+13105550000", senderEmail: null });
    tx.order.update.mockResolvedValueOnce({ senderName: "A", senderPhone: "+13105551234", senderEmail: null });
    await updateOrderBlock({ orderId: "o1", block: "sender", data: { senderName: "A", senderPhone: "3105551234" }, actor: { userId: "u", role: "OWNER" } });
    expect(tx.order.update.mock.calls[0][0].data.senderPhone).toBe("+13105551234");
  });
});

describe("updateOrderBlock — валидация", () => {
  it("недопустимый статус → invalid, транзакция не открывается", async () => {
    const res = await updateOrderBlock({ orderId: "o1", block: "status", data: { orderStatus: "AWAITING_PAYMENT" }, actor: { userId: "u", role: "OWNER" } });
    expect(res.status).toBe("invalid");
    expect($transaction).not.toHaveBeenCalled();
  });

  it("несуществующий заказ → notfound", async () => {
    tx.order.findUnique.mockResolvedValueOnce(null);
    const res = await updateOrderBlock({ orderId: "nope", block: "status", data: { orderStatus: "READY" }, actor: { userId: "u", role: "OWNER" } });
    expect(res.status).toBe("notfound");
    expect(tx.order.update).not.toHaveBeenCalled();
  });
});

describe("updateOrderBlock — окно из выбора времени", () => {
  it("«с — до» из формы: числа и текст одним форматом; «до» раньше «с» — ошибка", async () => {
    tx.order.findUnique.mockResolvedValueOnce({ deliveryDate: new Date("2026-07-20T00:00:00.000Z"), deliveryWindow: "11:00 - 15:00", windowFrom: 660, windowTo: 900 });
    tx.order.update.mockResolvedValueOnce({ deliveryDate: new Date("2026-07-20T00:00:00.000Z"), deliveryWindow: "17:00 - 21:00", windowFrom: 1020, windowTo: 1260 });
    const ok = await updateOrderBlock({ orderId: "o1", block: "delivery", data: { windowFrom: "17:00", windowTo: "21:00" }, actor: { userId: "u-o", role: "OWNER" } });
    expect(ok.status).toBe("ok");
    expect(tx.order.update.mock.calls.at(-1)![0].data).toMatchObject({ windowFrom: 1020, windowTo: 1260, deliveryWindow: "17:00 - 21:00" });

    const bad = await updateOrderBlock({ orderId: "o1", block: "delivery", data: { windowFrom: "18:00", windowTo: "17:00" }, actor: { userId: "u-o", role: "OWNER" } });
    expect(bad.status).toBe("invalid");
  });
});
