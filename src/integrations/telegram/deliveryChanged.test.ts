import { describe, it, expect } from "vitest";
import { getTelegramEvent } from "./registry";
import { renderDeliveryChanged } from "./templates";

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
    expect(text).toContain("Перенос доставки");
    expect(text).toContain("JF-1001374");
    expect(text).toContain("10.09.2026");
    expect(text).toContain("09.09.2026");
    expect(text).toContain("Ris Anderson");
  });

  it("если прежнее значение неизвестно, сообщение всё равно осмысленно", () => {
    const text = renderDeliveryChanged(order, null, "09.09.2026");
    expect(text).toContain("09.09.2026");
    expect(text).not.toContain("undefined");
    expect(text).not.toContain("null");
  });
});
