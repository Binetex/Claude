import { describe, it, expect } from "vitest";
import { matchCommunicationToOrder, type CommOrderCandidate } from "./matching";

const CUST = "+13105550111";
const RECIP = "+13105550222";
const day = (s: string) => new Date(`${s}T00:00:00Z`);

describe("matchCommunicationToOrder", () => {
  it("SMS от покупателя → CUSTOMER, нужный заказ (§16.1)", () => {
    const cands: CommOrderCandidate[] = [{ orderId: "o1", senderPhoneE164: CUST, recipientPhoneE164: RECIP, deliveryDate: day("2026-07-20"), orderStatus: "CONFIRMED" }];
    expect(matchCommunicationToOrder(CUST, new Date("2026-07-20T15:00:00Z"), cands)).toEqual({ matched: true, orderId: "o1", partyRole: "CUSTOMER" });
  });

  it("SMS от получателя → RECIPIENT (§16.2)", () => {
    const cands: CommOrderCandidate[] = [{ orderId: "o1", senderPhoneE164: CUST, recipientPhoneE164: RECIP, deliveryDate: day("2026-07-20"), orderStatus: "CONFIRMED" }];
    expect(matchCommunicationToOrder(RECIP, new Date("2026-07-20T15:00:00Z"), cands)).toEqual({ matched: true, orderId: "o1", partyRole: "RECIPIENT" });
  });

  it("нет кандидатов → no_candidate (unlinked)", () => {
    expect(matchCommunicationToOrder(CUST, new Date(), [])).toEqual({ matched: false, reason: "no_candidate" });
  });

  it("один телефон в нескольких заказах → ближайший активный (§16.8)", () => {
    const now = new Date("2026-07-20T15:00:00Z");
    const cands: CommOrderCandidate[] = [
      { orderId: "old", senderPhoneE164: CUST, recipientPhoneE164: null, deliveryDate: day("2026-05-01"), orderStatus: "DELIVERED" },
      { orderId: "today", senderPhoneE164: CUST, recipientPhoneE164: null, deliveryDate: day("2026-07-20"), orderStatus: "CONFIRMED" },
      { orderId: "future", senderPhoneE164: CUST, recipientPhoneE164: null, deliveryDate: day("2026-08-10"), orderStatus: "CONFIRMED" },
    ];
    expect(matchCommunicationToOrder(CUST, now, cands)).toEqual({ matched: true, orderId: "today", partyRole: "CUSTOMER" });
  });

  it("отменённый заказ не выбирается, если есть активный", () => {
    const now = new Date("2026-07-20T15:00:00Z");
    const cands: CommOrderCandidate[] = [
      { orderId: "cancelled", senderPhoneE164: CUST, recipientPhoneE164: null, deliveryDate: day("2026-07-20"), orderStatus: "CANCELLED" },
      { orderId: "active", senderPhoneE164: CUST, recipientPhoneE164: null, deliveryDate: day("2026-07-21"), orderStatus: "CONFIRMED" },
    ];
    expect(matchCommunicationToOrder(CUST, now, cands)).toEqual({ matched: true, orderId: "active", partyRole: "CUSTOMER" });
  });

  it("неоднозначное событие (два одинаково близких) → ambiguous, не привязываем (§16.9)", () => {
    const now = day("2026-07-20"); // ровно полночь → 19-е и 21-е равноудалены (по 24ч)
    const cands: CommOrderCandidate[] = [
      { orderId: "a", senderPhoneE164: CUST, recipientPhoneE164: null, deliveryDate: day("2026-07-19"), orderStatus: "CONFIRMED" },
      { orderId: "b", senderPhoneE164: CUST, recipientPhoneE164: null, deliveryDate: day("2026-07-21"), orderStatus: "CONFIRMED" },
    ];
    expect(matchCommunicationToOrder(CUST, now, cands)).toEqual({ matched: false, reason: "ambiguous" });
  });

  it("телефон совпал и как покупатель, и как получатель в одном заказе → CUSTOMER приоритетнее", () => {
    const cands: CommOrderCandidate[] = [{ orderId: "o1", senderPhoneE164: CUST, recipientPhoneE164: CUST, deliveryDate: day("2026-07-20"), orderStatus: "CONFIRMED" }];
    expect(matchCommunicationToOrder(CUST, new Date("2026-07-20T10:00:00Z"), cands)).toEqual({ matched: true, orderId: "o1", partyRole: "CUSTOMER" });
  });
});
