/**
 * Статусы Shopify-заказа: деривация при создании и anti-rollback при обновлении.
 * Ключевое для Stage 0 — обновление обязано доводить заказ до DELIVERED (иначе триггер
 * «Заказ доставлен» на Shopify не срабатывает), но НЕ затирать внутренние рабочие этапы.
 */
import { describe, it, expect } from "vitest";
import { deriveShopifyOrderState, reconcileShopifyUpdate } from "./orderState";

const signal = (over: { cancelledAt?: string | null; fulfillmentStatus?: string | null } = {}) => ({
  cancelledAt: over.cancelledAt ?? null,
  fulfillmentStatus: over.fulfillmentStatus ?? null,
});

describe("deriveShopifyOrderState (создание)", () => {
  it("отменённый заказ", () => {
    expect(deriveShopifyOrderState(signal({ cancelledAt: "2026-07-30T10:00:00Z" }), "PAID")).toEqual({ orderStatus: "CANCELLED" });
  });

  it("выполненный заказ → DELIVERED + доставка DELIVERED", () => {
    expect(deriveShopifyOrderState(signal({ fulfillmentStatus: "fulfilled" }), "PAID")).toEqual({
      orderStatus: "DELIVERED",
      deliveryStatus: "DELIVERED",
    });
  });

  it("оплачен → CONFIRMED, не оплачен → AWAITING_PAYMENT", () => {
    expect(deriveShopifyOrderState(signal(), "PAID")).toEqual({ orderStatus: "CONFIRMED" });
    expect(deriveShopifyOrderState(signal(), "UNPAID")).toEqual({ orderStatus: "AWAITING_PAYMENT" });
  });

  it("отмена приоритетнее выполнения", () => {
    expect(deriveShopifyOrderState(signal({ cancelledAt: "2026-07-30T10:00:00Z", fulfillmentStatus: "fulfilled" }), "PAID")).toEqual({
      orderStatus: "CANCELLED",
    });
  });
});

describe("reconcileShopifyUpdate (обновление существующего)", () => {
  it("fulfilled доводит заказ до DELIVERED", () => {
    expect(reconcileShopifyUpdate({ orderStatus: "CONFIRMED" }, signal({ fulfillmentStatus: "fulfilled" }), "PAID")).toEqual({
      orderStatus: "DELIVERED",
      deliveryStatus: "DELIVERED",
    });
  });

  it("fulfilled перекрывает внутренний рабочий этап — это терминальный факт платформы", () => {
    expect(reconcileShopifyUpdate({ orderStatus: "IN_PROGRESS" }, signal({ fulfillmentStatus: "fulfilled" }), "PAID")).toEqual({
      orderStatus: "DELIVERED",
      deliveryStatus: "DELIVERED",
    });
  });

  it("НЕтерминальное обновление не трогает рабочие этапы", () => {
    expect(reconcileShopifyUpdate({ orderStatus: "IN_PROGRESS" }, signal(), "PAID")).toEqual({});
    expect(reconcileShopifyUpdate({ orderStatus: "READY" }, signal(), "PAID")).toEqual({});
    expect(reconcileShopifyUpdate({ orderStatus: "CONFIRMED" }, signal(), "PAID")).toEqual({});
  });

  it("терминальный внутренний статус не откатывается ничем", () => {
    expect(reconcileShopifyUpdate({ orderStatus: "DELIVERED" }, signal(), "PAID")).toEqual({});
    expect(reconcileShopifyUpdate({ orderStatus: "CANCELLED" }, signal({ fulfillmentStatus: "fulfilled" }), "PAID")).toEqual({});
    expect(reconcileShopifyUpdate({ orderStatus: "DELIVERED" }, signal({ cancelledAt: "2026-07-30T10:00:00Z" }), "PAID")).toEqual({});
  });

  it("исторический переход «ожидал оплаты и оплатили» сохранён", () => {
    expect(reconcileShopifyUpdate({ orderStatus: "AWAITING_PAYMENT" }, signal(), "PAID")).toEqual({ orderStatus: "CONFIRMED" });
    expect(reconcileShopifyUpdate({ orderStatus: "AWAITING_PAYMENT" }, signal(), "UNPAID")).toEqual({});
  });

  it("отмена на стороне Shopify применяется к рабочему заказу", () => {
    expect(reconcileShopifyUpdate({ orderStatus: "IN_PROGRESS" }, signal({ cancelledAt: "2026-07-30T10:00:00Z" }), "PAID")).toEqual({
      orderStatus: "CANCELLED",
    });
  });
});
