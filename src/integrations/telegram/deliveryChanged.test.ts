import { describe, it, expect } from "vitest";
import { getTelegramEvent } from "./registry";
import { renderDeliveryChanged, renderOwnerDeliveryChanged, renderFloristNote, renderFloristMessage, buttonsFor } from "./templates";

const order = {
  id: "o1",
  orderNumber: "JF-1001374",
  siteName: "JF",
  senderName: "Bob",
  recipientName: "Ris Anderson",
  recipientPhone: "+13105550101",
  addressLine: "3959 Alta Mesa Dr",
  apartmentOrSuite: null,
  city: "Studio City",
  zip: "91604",
  deliveryDate: new Date("2026-09-09T00:00:00Z"),
  deliveryWindow: "09:00 - 15:00",
  cardMessage: null,
  courierNote: null,
  items: [],
  photoUrls: [],
} as unknown as Parameters<typeof renderDeliveryChanged>[0];

describe("перенос доставки — уведомление флористу", () => {
  it("тип есть в реестре и идёт личным ботом флориста", () => {
    const def = getTelegramEvent("order.delivery_changed");
    expect(def).toBeTruthy();
    expect(def!.audience).toBe("FLORIST");
    expect(def!.perFlorist).toBe(true);
  });

  it("новая дата — НОВОЕ сообщение, а не правка прежнего", () => {
    const def = getTelegramEvent("order.delivery_changed")!;
    const first = def.dedupeKey({ orderId: "o1", floristId: "f1", occurrence: "10Sep" });
    const second = def.dedupeKey({ orderId: "o1", floristId: "f1", occurrence: "9Sep" });
    expect(first).not.toBe(second);
  });

  it("у каждого флориста своё сообщение: ключ включает флориста", () => {
    const def = getTelegramEvent("order.delivery_changed")!;
    expect(def.dedupeKey({ orderId: "o1", floristId: "f1", occurrence: "x" }))
      .not.toBe(def.dedupeKey({ orderId: "o1", floristId: "f2", occurrence: "x" }));
  });

  it("в тексте видно и «было», и «стало» — иначе непонятно, что изменилось", () => {
    const text = renderDeliveryChanged(order, "10.09.2026 9AM – 3PM", "09.09.2026 9AM – 3PM");
    expect(text).toContain("Перенос JF-1001374");
    expect(text).toContain("10.09.2026");
    expect(text).toContain("09.09.2026");
  });

  it("номер, букет и новое время — одной первой строкой, прежнее время — ниже (решение владельца)", () => {
    const withBouquet = { ...order, items: [{ name: "Red Roses & Vase", variantName: "Large", quantity: 1, composition: null }] };
    const text = renderDeliveryChanged(withBouquet, "6PM – 9PM", "6PM – 7PM");
    expect(text).toBe("📅 <b>Перенос JF-1001374</b> (Red Roses &amp; Vase) Стало: <b>6PM – 7PM</b>\n(Было: 6PM – 9PM)");
    // Получатель и адрес — в карточке заказа выше, её правят тем же переносом.
    expect(text).not.toContain("Ris Anderson");
  });

  it("несколько букетов — через запятую, одинаковые не повторяются", () => {
    const item = (name: string) => ({ name, variantName: null, quantity: 1, composition: null });
    const text = renderDeliveryChanged({ ...order, items: [item("Red Roses"), item("Balloons"), item("Red Roses")] }, null, "6PM – 7PM");
    expect(text.split("\n")[0]).toContain("(Red Roses, Balloons) Стало:");
  });

  it("если прежнее значение неизвестно, сообщение всё равно осмысленно", () => {
    const text = renderDeliveryChanged(order, null, "09.09.2026");
    expect(text).toContain("09.09.2026");
    expect(text).not.toContain("undefined");
    expect(text).not.toContain("null");
  });
});

describe("перенос доставки — короткое уведомление владельцу", () => {
  it("тип есть в реестре, адресат — владелец, флорист не требуется", () => {
    const def = getTelegramEvent("order.delivery_changed_owner");
    expect(def).toBeTruthy();
    expect(def!.audience).toBe("OWNER");
    expect(def!.perFlorist).toBe(false);
  });

  it("каждый перенос — новое сообщение, а не правка прежнего", () => {
    const def = getTelegramEvent("order.delivery_changed_owner")!;
    expect(def.dedupeKey({ orderId: "o1", occurrence: "10Sep" }))
      .not.toBe(def.dedupeKey({ orderId: "o1", occurrence: "9Sep" }));
  });

  it("в сообщении только номер заказа и новое время — владельцу нужна лента, а не карточка", () => {
    const text = renderOwnerDeliveryChanged(order);
    expect(text).toContain("Клиент изменил время доставки");
    expect(text).toContain("JF-1001374");
    expect(text).toContain("9 Sep");
    // Подробности заказа сюда не тянем: они есть в карточке, которую освежает order.created.
    expect(text).not.toContain("Ris Anderson");
    expect(text).not.toContain("Alta Mesa");
    expect(text.split("\n").length).toBeLessThanOrEqual(3);
  });

  it("время берётся из заказа целиком: смена одного окна не оставляет время без даты", () => {
    const text = renderOwnerDeliveryChanged(order);
    expect(text).toContain("9 Sep");
    expect(text).toMatch(/9 Sep.*9AM|9 Sep,/);
    expect(text).not.toContain("undefined");
    expect(text).not.toContain("null");
  });
});

describe("изменение заказа — флористу (доплата за другой букет, 29.09.2026)", () => {
  it("тип в реестре: личным ботом флориста, каждое изменение — новое сообщение", () => {
    const def = getTelegramEvent("order.florist_note")!;
    expect(def.audience).toBe("FLORIST");
    expect(def.perFlorist).toBe(true);
    expect(def.dedupeKey({ orderId: "o1", floristId: "f1", occurrence: "a" })).not.toBe(def.dedupeKey({ orderId: "o1", floristId: "f1", occurrence: "b" }));
  });

  it("номер, букет и что делать — без денег", () => {
    const withBouquet = { ...order, items: [{ name: "Golden Chestnut", variantName: null, quantity: 1, composition: null }] };
    expect(renderFloristNote(withBouquet, "Вместо него — Red Roses & Vase")).toBe("✏️ <b>Изменение JF-1001374</b> (Golden Chestnut)\nВместо него — Red Roses &amp; Vase");
  });
});

describe("букет заменён — флористу новой карточкой (30.09.2026)", () => {
  it("тип в реестре: личным ботом флориста, каждая замена — новое сообщение", () => {
    const def = getTelegramEvent("order.item_replaced")!;
    expect(def.audience).toBe("FLORIST");
    expect(def.dedupeKey({ orderId: "o1", floristId: "f1", occurrence: "a" })).not.toBe(def.dedupeKey({ orderId: "o1", floristId: "f1", occurrence: "b" }));
  });

  it("та же карточка, что при назначении, с заголовком «Букет заменён» и тем, что было", () => {
    const text = renderFloristMessage({ ...order, items: [{ name: "Red Roses & Vase", variantName: "Large", quantity: 1, composition: null }] }, { replacedFrom: "Golden Chestnut, Small" });
    expect(text.split("\n")[0]).toBe("🔁 <b>Букет заменён</b> · <b>JF-1001374</b> · JF");
    expect(text.split("\n")[1]).toBe("Было: Golden Chestnut, Small");
    expect(text).toContain("Red Roses &amp; Vase");
  });

  it("у флористских сообщений кнопка открывает карточку ФЛОРИСТА, а не кабинет владельца", () => {
    for (const type of ["order.item_replaced", "order.delivery_changed", "order.florist_note"] as const) {
      expect(buttonsFor(type, order)[0].url).toContain("/dashboard/f/o1");
    }
  });
});
