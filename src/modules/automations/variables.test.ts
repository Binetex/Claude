/**
 * Переменные шаблона. Отдельный акцент на дате доставки: это поле уже приводило к отправке
 * клиенту SMS с датой на сутки раньше настоящей (заказ на 31-е, в сообщении 30-е).
 */
import { describe, it, expect } from "vitest";
import { buildOrderVariables, type OrderVariableSource } from "./variables";

const src = (over: Partial<OrderVariableSource> = {}): OrderVariableSource => ({
  orderNumber: "TF-20328",
  senderName: "Anna",
  recipientName: "Maria",
  senderPhone: "+15551112222",
  recipientPhone: "+15553334444",
  addressLine: "1 Main St",
  apartment: "4",
  city: "Portland",
  deliveryDate: new Date("2026-07-31T00:00:00.000Z"),
  deliveryWindow: "14:00 – 18:00",
  trackingUrl: null,
  cardMessage: "Happy Birthday!",
  deliveryInstructions: "Leave at door",
  customerTotal: 115,
  storeName: "The Flow",
  storePhone: "+15550001111",
  reviewUrl: null,
  timezone: "America/Los_Angeles",
  ...over,
});

describe("delivery_date", () => {
  it("день доставки НЕ съезжает на сутки назад в западной таймзоне магазина", () => {
    // Order.deliveryDate — UTC-полночь ЛОКАЛЬНОГО дня. Пере-конвертация в America/Los_Angeles
    // дала бы «2026-07-30» — ровно тот баг, из-за которого клиенту ушла неверная дата.
    expect(buildOrderVariables(src()).delivery_date).toBe("2026-07-31");
  });

  it("одинаково для любой таймзоны магазина — день доставки от неё не зависит", () => {
    for (const timezone of ["America/Los_Angeles", "America/New_York", "Europe/Moscow", "Asia/Tokyo", "UTC", null]) {
      expect(buildOrderVariables(src({ timezone })).delivery_date).toBe("2026-07-31");
    }
  });

  it("восточная таймзона тоже не сдвигает дату вперёд", () => {
    expect(buildOrderVariables(src({ deliveryDate: new Date("2026-01-01T00:00:00.000Z"), timezone: "Asia/Tokyo" })).delivery_date).toBe("2026-01-01");
  });

  it("некорректная таймзона магазина не ломает рендер", () => {
    expect(buildOrderVariables(src({ timezone: "Not/AZone" })).delivery_date).toBe("2026-07-31");
  });

  it("нет даты — пустая строка, а не «undefined»", () => {
    expect(buildOrderVariables(src({ deliveryDate: null })).delivery_date).toBe("");
  });
});

describe("остальные переменные", () => {
  it("собираются в ожидаемом виде", () => {
    const v = buildOrderVariables(src());
    expect(v.order_number).toBe("TF-20328");
    expect(v.delivery_address).toBe("1 Main St, 4, Portland");
    expect(v.delivery_time).toBe("14:00 – 18:00");
    expect(v.order_total).toBe("$115.00");
    expect(v.store_name).toBe("The Flow");
  });

  it("пустые поля дают пустую строку", () => {
    const v = buildOrderVariables(src({ trackingUrl: null, reviewUrl: null, customerTotal: null, apartment: null }));
    expect(v.tracking_url).toBe("");
    expect(v.review_url).toBe("");
    expect(v.order_total).toBe("");
    expect(v.delivery_address).toBe("1 Main St, Portland");
  });
});
