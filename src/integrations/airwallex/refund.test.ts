import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { computeRefundAmounts, createOrderRefund } from "./refund";
import type { AirwallexRefund } from "./client";

// Путь возврата целиком, без базы и без денег: платёж заказа, ключи магазина и задача
// «записать возврат в магазин» подменены, Airwallex — заглушка fetch по адресам документации.
const h = vi.hoisted(() => ({ pushed: [] as unknown[] }));
vi.mock("@/lib/db", () => ({
  prisma: { airwallexPayment: { findUnique: async () => ({ siteId: "s1", paymentIntentId: "int_1" }) } },
}));
vi.mock("./settings", () => ({ resolveAirwallexCreds: async () => ({ clientId: "cid", apiKey: "akey", env: "prod" }) }));
vi.mock("@/integrations/woocommerce/refundPushEvents", () => ({
  publishWooRefundPush: async (_prisma: unknown, input: unknown) => {
    h.pushed.push(input);
    return { created: true };
  },
}));

const r = (amount: number, status: string): AirwallexRefund => ({
  id: `rfd_${status}_${amount}`,
  status,
  amount,
  currency: "USD",
  reason: null,
  createdAt: null,
});

/**
 * Сколько можно вернуть. Ошибка здесь стоит настоящих денег: занизишь — владелец не сможет
 * вернуть положенное, завысишь — вернёт больше, чем клиент заплатил.
 */
describe("остаток к возврату", () => {
  it("возвратов не было — доступна вся списанная сумма", () => {
    expect(computeRefundAmounts(312.93, [])).toEqual({ refundedAmount: 0, availableAmount: 312.93 });
  });

  it("частичный возврат уменьшает остаток", () => {
    expect(computeRefundAmounts(312.93, [r(100, "SETTLED")])).toEqual({
      refundedAmount: 100,
      availableAmount: 212.93,
    });
  });

  it("несколько возвратов складываются", () => {
    expect(computeRefundAmounts(500, [r(100, "SETTLED"), r(50.5, "SETTLED")])).toEqual({
      refundedAmount: 150.5,
      availableAmount: 349.5,
    });
  });

  it("ИДУЩИЙ возврат тоже занимает сумму — иначе вернём дважды, пока первый в пути", () => {
    expect(computeRefundAmounts(200, [r(200, "RECEIVED")])).toEqual({ refundedAmount: 200, availableAmount: 0 });
    expect(computeRefundAmounts(200, [r(80, "PENDING")]).availableAmount).toBe(120);
    expect(computeRefundAmounts(200, [r(80, "PROCESSING")]).availableAmount).toBe(120);
  });

  it("несостоявшиеся возвраты сумму не занимают", () => {
    for (const dead of ["FAILED", "CANCELLED", "EXPIRED", "DECLINED"]) {
      expect(computeRefundAmounts(200, [r(200, dead)])).toEqual({ refundedAmount: 0, availableAmount: 200 });
    }
  });

  it("регистр статуса не важен — Airwallex может прислать любой", () => {
    expect(computeRefundAmounts(200, [r(200, "failed")]).availableAmount).toBe(200);
  });

  it("незнакомый статус считается занятым — осторожность важнее полноты", () => {
    // Новый статус в API не должен молча открыть возврат уже возвращённых денег.
    expect(computeRefundAmounts(200, [r(200, "SOME_NEW_STATUS")]).availableAmount).toBe(0);
  });

  it("возвращено полностью — доступно ноль, а не отрицательное число", () => {
    expect(computeRefundAmounts(312.93, [r(312.93, "SETTLED")])).toEqual({
      refundedAmount: 312.93,
      availableAmount: 0,
    });
  });

  it("возвращено больше списанного (ручные операции в кабинете) — тоже ноль, не минус", () => {
    expect(computeRefundAmounts(100, [r(150, "SETTLED")]).availableAmount).toBe(0);
  });

  it("копейки не накапливают погрешность", () => {
    const res = computeRefundAmounts(0.3, [r(0.1, "SETTLED"), r(0.1, "SETTLED")]);
    expect(res.refundedAmount).toBe(0.2);
    expect(res.availableAmount).toBe(0.1); // а не 0.09999999999999998
  });
});

/**
 * Частичный возврат по-настоящему: заказ оплачен на $120, владелец возвращает часть. Проверяем,
 * что в Airwallex уходит ровно эта сумма, второй возврат видит только остаток, лишнее
 * отсекается ДО запроса, а магазину ставится задача на сумму, которую вернул Airwallex.
 */
describe("частичный возврат — путь до Airwallex и задачи магазину", () => {
  const PAID = 120;
  let existing: Record<string, unknown>[] = [];
  let network = false;
  const calls: { url: string; body: Record<string, unknown> | null }[] = [];
  const json = (status: number, body: unknown) => ({ status, json: async () => body });

  beforeEach(() => {
    existing = [];
    network = false;
    calls.length = 0;
    h.pushed.length = 0;
    vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
      const u = String(url);
      const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
      calls.push({ url: u, body });
      if (u.endsWith("/api/v1/authentication/login")) return json(201, { token: "tok", expires_at: new Date(Date.now() + 1800_000).toISOString() });
      if (u.endsWith("/api/v1/pa/payment_intents/int_1")) return json(200, { status: "SUCCEEDED", amount: PAID, captured_amount: PAID, currency: "USD" });
      if (u.includes("/api/v1/pa/refunds?payment_intent_id=int_1")) return json(200, { has_more: false, items: existing });
      if (u.endsWith("/api/v1/pa/refunds/create")) {
        if (network) throw new Error("socket hang up");
        return json(201, { id: "rfd_new", amount: body?.amount, currency: "USD", status: "RECEIVED", reason: body?.reason, created_at: "2026-10-03T18:00:00+00:00" });
      }
      throw new Error(`неожиданный запрос ${u}`);
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  const refund = (amount: number, requestId = "req-1") =>
    createOrderRefund({ orderId: "o1", amount, reason: "Requested by customer", requestId });
  const createBodies = () => calls.filter((c) => c.url.endsWith("/refunds/create")).map((c) => c.body);

  it("часть суммы: в Airwallex уходит ровно она, магазину — задача на неё же", async () => {
    expect(await refund(25.5)).toMatchObject({ ok: true, refund: { id: "rfd_new", amount: 25.5, status: "RECEIVED" } });
    expect(createBodies()).toEqual([{ request_id: "req-1", payment_intent_id: "int_1", amount: 25.5, reason: "Requested by customer" }]);
    expect(h.pushed).toEqual([{ orderId: "o1", refundId: "rfd_new", amount: 25.5, reason: "Requested by customer" }]);
  });

  it("второй частичный — доступен остаток: идущий первый возврат его уже занял", async () => {
    existing = [{ id: "rfd_1", amount: 25.5, currency: "USD", status: "RECEIVED" }];
    expect(await refund(94.5, "req-2")).toMatchObject({ ok: true });
    expect(createBodies()).toEqual([expect.objectContaining({ amount: 94.5, request_id: "req-2" })]);
  });

  it("больше остатка — отказ ДО запроса в Airwallex, магазину ничего", async () => {
    existing = [{ id: "rfd_1", amount: 25.5, currency: "USD", status: "SETTLED" }];
    expect(await refund(94.51, "req-3")).toEqual({ ok: false, kind: "rejected", message: "Доступно к возврату 94.5 USD, запрошено 94.51." });
    expect(createBodies()).toHaveLength(0);
    expect(h.pushed).toHaveLength(0);
  });

  it("сорвавшийся возврат сумму не занимает", async () => {
    existing = [{ id: "rfd_1", amount: PAID, currency: "USD", status: "FAILED" }];
    expect(await refund(30, "req-4")).toMatchObject({ ok: true });
  });

  it("сумма режется до центов", async () => {
    await refund(33.333, "req-5");
    expect(createBodies()).toEqual([expect.objectContaining({ amount: 33.33 })]);
  });

  it("обрыв сети на создании — «неизвестно», и магазину не пишем", async () => {
    network = true;
    expect(await refund(10, "req-6")).toMatchObject({ ok: false, kind: "unknown" });
    expect(h.pushed).toHaveLength(0);
  });
});
