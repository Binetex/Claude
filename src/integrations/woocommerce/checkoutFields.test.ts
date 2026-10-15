import { describe, it, expect } from "vitest";
import { retakeOnPaid, type CheckoutFields } from "./checkoutFields";

// THEFLOW-21248: неудачная попытка — 16-е, оплаченная форма — 15-е.
const ours = {
  deliveryDate: new Date("2026-10-16T00:00:00Z"),
  deliveryWindow: "11:00 - 15:00", windowFrom: 660, windowTo: 900,
  recipientName: "Ann Lee", recipientPhone: "+13105550001",
  addressLine: "1 Main St", apartment: null, city: "LA", zip: "90001",
  cardMessage: "Happy birthday",
};
const form = (over: Partial<CheckoutFields> = {}): CheckoutFields => ({
  ...ours, deliveryDate: new Date("2026-10-16T00:00:00Z"), originalCardMessage: ours.cardMessage, ...over,
});
const none = new Set<string>();

describe("retakeOnPaid — оплаченная форма главнее неудачной попытки (THEFLOW-21248)", () => {
  it("форма та же — брать нечего", () => {
    const r = retakeOnPaid(ours, form(), none);
    expect(r.data).toEqual({});
    expect(r.deliveryChanged).toBe(false);
  });

  it("другой день — берём день, окно то же", () => {
    const r = retakeOnPaid(ours, form({ deliveryDate: new Date("2026-10-15T00:00:00Z") }), none);
    expect(r.data).toEqual({ deliveryDate: new Date("2026-10-15T00:00:00Z") });
    expect(r.dateChanged).toBe(true);
    expect(r.deliveryChanged).toBe(true);
  });

  it("другой слот — берём окно целиком", () => {
    const r = retakeOnPaid(ours, form({ deliveryWindow: "18:00 - 21:00", windowFrom: 1080, windowTo: 1260 }), none);
    expect(r.data).toEqual({ deliveryWindow: "18:00 - 21:00", windowFrom: 1080, windowTo: 1260 });
    expect(r.dateChanged).toBe(false);
  });

  it("сайт день не прислал — наш не трогаем", () => {
    expect(retakeOnPaid(ours, form({ deliveryDate: null }), none).data).toEqual({});
  });

  it("день у нас правил человек — его решение главнее формы", () => {
    const r = retakeOnPaid(ours, form({ deliveryDate: new Date("2026-10-15T00:00:00Z") }), new Set(["delivery"]));
    expect(r.data).toEqual({});
  });

  it("адрес и получатель — по полям; правка человеком в «Контактах» их держит", () => {
    const f = form({ addressLine: "9 Oak Ave", zip: "90046", recipientPhone: "+13105559999" });
    const r = retakeOnPaid(ours, f, none);
    expect(r.data).toEqual({ addressLine: "9 Oak Ave", zip: "90046", recipientPhone: "+13105559999" });
    expect(r.contactsChanged).toBe(true);
    expect(retakeOnPaid(ours, f, new Set(["contacts"])).data).toEqual({});
  });

  it("открытка — вместе с сырым текстом", () => {
    const r = retakeOnPaid(ours, form({ cardMessage: "Love you", originalCardMessage: "Love you &amp;" }), none);
    expect(r.data).toEqual({ cardMessage: "Love you", originalCardMessage: "Love you &amp;" });
    expect(retakeOnPaid(ours, form({ cardMessage: "Love you" }), new Set(["cardNote"])).data).toEqual({});
  });
});
