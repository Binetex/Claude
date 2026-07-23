/**
 * Тексты уведомлений. Главное, что проверяем: флористу не утекают финансы владельца
 * и ссылки ведут в правильные разделы.
 */
import { describe, it, expect } from "vitest";
import { renderFloristMessage, renderFloristHandedOver, renderOwnerCreated, buttonsFor, googleMapsUrl, floristOrderUrl, ownerOrderUrl, type OrderSnapshot } from "./templates";

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
  imageUrl: "https://cdn.example/bouquet.jpg",
  items: [{ name: "Petal Poetry", variantName: "Standard", quantity: 1, composition: "pink peony (10)\ngreen eucalyptus" }],
};

describe("сообщение флористу", () => {
  const text = renderFloristMessage(order);

  it("содержит всё, что нужно для сборки букета", () => {
    for (const part of ["THEFLOW-20292", "TheFlow", "2026-07-24", "12:00 – 16:00", "Ann Recipient", "1 Main St", "Apt 4", "Petal Poetry", "pink peony (10)", "Позвонить за 10 минут"]) {
      expect(text).toContain(part);
    }
  });

  it("НЕ содержит финансов владельца", () => {
    for (const forbidden of ["прибыл", "Прибыл", "себестоим", "estimatedProfit", "customerTotal"]) {
      expect(text).not.toContain(forbidden);
    }
  });

  it("сообщение прежнему флористу: заказ больше не за ним, без лишних деталей", () => {
    const handed = renderFloristHandedOver(order, "Пётр");
    expect(handed).toContain("передан");
    expect(handed).toContain("Пётр");
    expect(handed).toContain("THEFLOW-20292");
    expect(handed).toContain("больше не за вами");
    // Состав здесь не нужен — заказ уже не его.
    expect(handed).not.toContain("pink peony");
  });

  it("открытку флористу НЕ показываем", () => {
    expect(text).not.toContain("С днём рождения");
    expect(text).not.toContain("Открытка");
  });

  it("адрес и время доставки выделены жирным", () => {
    expect(text).toContain("⏰ <b>12:00 – 16:00</b>");
    expect(text).toContain("📍 <b>1 Main St, Apt 4, Los Angeles, 90001</b>");
  });

  it("пустые поля не оставляют висящих подписей", () => {
    const bare = renderFloristMessage({ ...order, deliveryInstructions: "  ", apartment: null });
    expect(bare).not.toContain("Инструкции:");
    expect(bare).not.toContain("📝");
  });

  it("HTML экранируется — вредный ввод не ломает разметку", () => {
    const evil = renderFloristMessage({ ...order, recipientName: "<b>hack</b> & co" });
    expect(evil).toContain("&lt;b&gt;hack&lt;/b&gt; &amp; co");
  });

  it("подпись фото не превышает лимит Telegram (1024)", () => {
    const huge = "цветок ".repeat(400); // ~2800 символов
    const withPhoto = renderFloristMessage({ ...order, items: [{ name: huge, variantName: null, quantity: 1, composition: huge }] });
    expect(withPhoto.length).toBeLessThanOrEqual(1024);
    // без фото обрезки нет
    const noPhoto = renderFloristMessage({ ...order, imageUrl: null, items: [{ name: huge, variantName: null, quantity: 1, composition: huge }] });
    expect(noPhoto.length).toBeGreaterThan(1024);
  });
});

describe("кнопки под сообщением", () => {
  it("флорист: Open Order + Google Maps (адрес получателя)", () => {
    const btns = buttonsFor("order.assigned", order);
    expect(btns).toHaveLength(2);
    expect(btns[0].url).toMatch(/\/dashboard\/f\/o1$/);
    expect(btns[1].text).toContain("Google Maps");
    expect(btns[1].url).toBe(googleMapsUrl("1 Main St, Apt 4, Los Angeles, 90001"));
  });

  it("нет адреса → кнопки Google Maps нет", () => {
    const btns = buttonsFor("order.assigned", { ...order, addressLine: null, apartment: null, city: null, zip: null });
    expect(btns).toHaveLength(1);
  });

  it("владелец: только Open Order на карточку заказа", () => {
    const btns = buttonsFor("order.created", order);
    expect(btns).toHaveLength(1);
    expect(btns[0].url).toMatch(/\/dashboard\/orders\/o1$/);
  });

  it("floristOrderUrl / ownerOrderUrl ведут в разные разделы", () => {
    expect(floristOrderUrl("o1")).toMatch(/\/dashboard\/f\/o1$/);
    expect(ownerOrderUrl("o1")).toMatch(/\/dashboard\/orders\/o1$/);
  });
});

describe("сообщение владельцу", () => {
  it("показывает статус оплаты — владелец видит и неоплаченные", () => {
    expect(renderOwnerCreated(order, "UNPAID")).toContain("UNPAID");
  });
});
