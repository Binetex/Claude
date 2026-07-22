/**
 * Тексты уведомлений. Главное, что проверяем: флористу не утекают финансы владельца
 * и ссылки ведут в правильные разделы.
 */
import { describe, it, expect } from "vitest";
import { renderFloristMessage, renderOwnerCreated, buttonFor, floristOrderUrl, ownerOrderUrl, type OrderSnapshot } from "./templates";

const order: OrderSnapshot = {
  id: "o1",
  orderNumber: "THEFLOW-20292",
  siteName: "TheFlow",
  deliveryDate: new Date("2026-07-24T00:00:00Z"),
  deliveryWindow: "12:00 – 16:00",
  recipientName: "Ann Recipient",
  addressLine: "1 Main St",
  apartment: "Apt 4",
  city: "Los Angeles",
  zip: "90001",
  cardMessage: "С днём рождения!",
  deliveryInstructions: "Позвонить за 10 минут",
  items: [{ name: "Petal Poetry", variantName: "Standard", quantity: 1, composition: "pink peony (10)\ngreen eucalyptus" }],
};

describe("сообщение флористу", () => {
  const text = renderFloristMessage(order);

  it("содержит всё, что нужно для сборки букета", () => {
    for (const part of ["THEFLOW-20292", "TheFlow", "2026-07-24", "12:00 – 16:00", "Ann Recipient", "1 Main St", "Apt 4", "Petal Poetry", "pink peony (10)", "С днём рождения!", "Позвонить за 10 минут"]) {
      expect(text).toContain(part);
    }
  });

  it("НЕ содержит финансов владельца", () => {
    for (const forbidden of ["прибыл", "Прибыл", "себестоим", "estimatedProfit", "customerTotal"]) {
      expect(text).not.toContain(forbidden);
    }
  });

  it("передача заказа меняет заголовок, а не тело", () => {
    const re = renderFloristMessage(order, { reassigned: true });
    expect(re).toContain("передан");
    expect(re).toContain("Petal Poetry");
  });

  it("пустые поля не оставляют висящих подписей", () => {
    const bare = renderFloristMessage({ ...order, cardMessage: null, deliveryInstructions: "  ", apartment: null });
    expect(bare).not.toContain("Открытка:");
    expect(bare).not.toContain("Инструкции:");
  });

  it("HTML экранируется — текст открытки не ломает разметку", () => {
    const evil = renderFloristMessage({ ...order, cardMessage: "<b>hack</b> & co" });
    expect(evil).toContain("&lt;b&gt;hack&lt;/b&gt; &amp; co");
  });
});

describe("ссылки Open Order", () => {
  it("флористу — в его раздел, владельцу — в карточку заказа", () => {
    expect(floristOrderUrl("o1")).toMatch(/\/dashboard\/f\/o1$/);
    expect(ownerOrderUrl("o1")).toMatch(/\/dashboard\/orders\/o1$/);
    expect(buttonFor("order.assigned", "o1").url).toMatch(/\/dashboard\/f\/o1$/);
    expect(buttonFor("order.reassigned", "o1").url).toMatch(/\/dashboard\/f\/o1$/);
    expect(buttonFor("order.created", "o1").url).toMatch(/\/dashboard\/orders\/o1$/);
    expect(buttonFor("delivery.problem", "o1").url).toMatch(/\/dashboard\/orders\/o1$/);
  });
});

describe("сообщение владельцу", () => {
  it("показывает статус оплаты — владелец видит и неоплаченные", () => {
    expect(renderOwnerCreated(order, "UNPAID")).toContain("UNPAID");
  });
});
