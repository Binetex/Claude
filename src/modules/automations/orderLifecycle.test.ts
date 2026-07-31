/**
 * Переходы жизненного цикла заказа → триггеры. Главное, что здесь проверяется, — триггер
 * рождается ТОЛЬКО на переходе: повторный webhook/resync с тем же состоянием молчит.
 */
import { describe, it, expect } from "vitest";
import { orderLifecycleTriggers, type OrderLifecycleSnapshot } from "./orderLifecycle";

const s = (orderStatus: string, paymentStatus: string): OrderLifecycleSnapshot => ({ orderStatus, paymentStatus });

describe("orderLifecycleTriggers — ORDER_PAID", () => {
  it("переход UNPAID → PAID", () => {
    expect(orderLifecycleTriggers(s("AWAITING_PAYMENT", "UNPAID"), s("CONFIRMED", "PAID"))).toEqual(["ORDER_PAID"]);
  });

  it("BNPL-approved считается оплатой (как условие requirePaid)", () => {
    expect(orderLifecycleTriggers(s("AWAITING_PAYMENT", "UNPAID"), s("CONFIRMED", "PAY_LATER_APPROVED"))).toEqual(["ORDER_PAID"]);
  });

  it("уже оплаченный заказ повторного триггера НЕ даёт (resync)", () => {
    expect(orderLifecycleTriggers(s("CONFIRMED", "PAID"), s("CONFIRMED", "PAID"))).toEqual([]);
    expect(orderLifecycleTriggers(s("IN_PROGRESS", "PAID"), s("READY", "PAID"))).toEqual([]);
  });

  it("PAY_LATER_APPROVED → PAID не считается новой оплатой (оба paid-like)", () => {
    expect(orderLifecycleTriggers(s("CONFIRMED", "PAY_LATER_APPROVED"), s("CONFIRMED", "PAID"))).toEqual([]);
  });

  it("заказ создан уже оплаченным — оплата публикуется (обычный путь Shopify)", () => {
    expect(orderLifecycleTriggers(null, s("CONFIRMED", "PAID"))).toEqual(["ORDER_PAID"]);
  });

  it("заказ создан неоплаченным — молчим", () => {
    expect(orderLifecycleTriggers(null, s("AWAITING_PAYMENT", "UNPAID"))).toEqual([]);
  });
});

describe("orderLifecycleTriggers — ORDER_DELIVERED", () => {
  it("переход в DELIVERED", () => {
    expect(orderLifecycleTriggers(s("CONFIRMED", "PAID"), s("DELIVERED", "PAID"))).toEqual(["ORDER_DELIVERED"]);
  });

  it("уже доставленный заказ повторного триггера НЕ даёт", () => {
    expect(orderLifecycleTriggers(s("DELIVERED", "PAID"), s("DELIVERED", "PAID"))).toEqual([]);
  });

  it("на СОЗДАНИИ уже доставленного заказа не публикуется (импорт, а не переход)", () => {
    // Оплата при этом публикуется — это состояние, а не наблюдённое событие доставки.
    expect(orderLifecycleTriggers(null, s("DELIVERED", "PAID"))).toEqual(["ORDER_PAID"]);
  });

  it("оплата и доставка в одном переходе дают оба триггера", () => {
    expect(orderLifecycleTriggers(s("AWAITING_PAYMENT", "UNPAID"), s("DELIVERED", "PAID"))).toEqual([
      "ORDER_PAID",
      "ORDER_DELIVERED",
    ]);
  });
});

describe("orderLifecycleTriggers — ORDER_CANCELLED", () => {
  it("переход в CANCELLED", () => {
    expect(orderLifecycleTriggers(s("CONFIRMED", "PAID"), s("CANCELLED", "PAID"))).toEqual(["ORDER_CANCELLED"]);
  });

  it("уже отменённый заказ повторного триггера НЕ даёт", () => {
    expect(orderLifecycleTriggers(s("CANCELLED", "UNPAID"), s("CANCELLED", "UNPAID"))).toEqual([]);
  });

  it("на СОЗДАНИИ отменённого заказа не публикуется", () => {
    expect(orderLifecycleTriggers(null, s("CANCELLED", "UNPAID"))).toEqual([]);
  });

  it("возврат (Woo refunded: CANCELLED + REFUNDED) отдаёт ORDER_REFUNDED, а не ORDER_CANCELLED", () => {
    // ORDER_REFUNDED публикуется отдельно (paymentTriggers) — здесь важно НЕ продублировать.
    expect(orderLifecycleTriggers(s("CONFIRMED", "PAID"), s("CANCELLED", "REFUNDED"))).toEqual([]);
  });

  it("отмена ПОСЛЕ уже случившегося возврата — самостоятельное событие", () => {
    // Возврат отработал раньше (там и ушёл ORDER_REFUNDED); дублирования нет, а сама отмена
    // — отдельный переход, о котором правило на ORDER_CANCELLED должно узнать.
    expect(orderLifecycleTriggers(s("CONFIRMED", "REFUNDED"), s("CANCELLED", "REFUNDED"))).toEqual(["ORDER_CANCELLED"]);
  });
});
