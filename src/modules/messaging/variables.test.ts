/**
 * Переменные шаблона. Отдельный акцент на дате доставки: это поле уже приводило к отправке
 * клиенту SMS с датой на сутки раньше настоящей (заказ на 31-е, в сообщении 30-е).
 */
import { describe, it, expect } from "vitest";
import { buildOrderVariables, resolveSupportEmail, type OrderVariableSource } from "./variables";

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
  supportEmail: "support@theflow.la",
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

describe("псевдонимы под Brevo-шаблоны", () => {
  it("customer_name и site_name — те же данные, что sender_name и store_name", () => {
    const v = buildOrderVariables(src());
    expect(v.customer_name).toBe("Anna");
    expect(v.site_name).toBe("The Flow");
    // Существующие имена обязаны остаться: на них завязаны SMS-шаблоны в проде.
    expect(v.sender_name).toBe("Anna");
    expect(v.store_name).toBe("The Flow");
    expect(v.customer_name).toBe(v.sender_name);
    expect(v.site_name).toBe(v.store_name);
  });

  it("support_email отдаётся в шаблон", () => {
    expect(buildOrderVariables(src()).support_email).toBe("support@theflow.la");
  });

  it("пустые значения дают '', а не «undefined»", () => {
    const v = buildOrderVariables(src({ senderName: null, storeName: null, supportEmail: null }));
    expect(v.customer_name).toBe("");
    expect(v.site_name).toBe("");
    expect(v.support_email).toBe("");
  });
});

describe("resolveSupportEmail: reply-to → адрес отправителя", () => {
  it("берёт reply-to, когда он задан", () => {
    expect(resolveSupportEmail({ replyTo: "help@shop.com", senderEmail: "admin@shop.com" })).toBe("help@shop.com");
  });

  it("падает на адрес отправителя, когда reply-to не заполнен", () => {
    // Ровно случай Julie's Flowers: reply-to пуст, отправитель admin@juliesflowers.net.
    expect(resolveSupportEmail({ replyTo: null, senderEmail: "admin@juliesflowers.net" })).toBe("admin@juliesflowers.net");
    expect(resolveSupportEmail({ replyTo: "   ", senderEmail: "admin@juliesflowers.net" })).toBe("admin@juliesflowers.net");
  });

  it("нет настроек Email у магазина — null, а не падение", () => {
    expect(resolveSupportEmail(null)).toBeNull();
    expect(resolveSupportEmail(undefined)).toBeNull();
    expect(resolveSupportEmail({ replyTo: null, senderEmail: null })).toBeNull();
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

describe("variables.buildOrderVariables", () => {
  it("форматирует адрес/дату/деньги и пустые поля → ''", () => {
    const v = buildOrderVariables({
      orderNumber: "#1001", senderName: "Anna", recipientName: "Maria",
      senderPhone: "+15551112222", recipientPhone: "+15553334444",
      addressLine: "1 Main St", apartment: "4", city: "Portland",
      deliveryDate: new Date("2026-07-25T12:00:00Z"), deliveryWindow: "14:00 – 18:00",
      trackingUrl: null, cardMessage: "", deliveryInstructions: "Leave at door",
      customerTotal: 115, storeName: "Floremart", storePhone: "+15550000000",
      reviewUrl: "https://rev", timezone: "UTC", supportEmail: "help@shop.com",
    });
    expect(v.order_number).toBe("#1001");
    expect(v.delivery_address).toBe("1 Main St, 4, Portland");
    expect(v.delivery_date).toBe("2026-07-25");
    expect(v.order_total).toBe("$115.00");
    expect(v.tracking_url).toBe(""); // null → ""
    expect(v.card_message).toBe("");
    expect(v.review_url).toBe("https://rev");
  });
});
