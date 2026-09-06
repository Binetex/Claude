import { describe, it, expect } from "vitest";
import { describeContact } from "./queueView";

/**
 * Подпись последнего общения в карточке очереди отзывов. Оператор читает её перед звонком,
 * поэтому «пропущенный» и «мы написали» обязаны различаться словами, а не только иконкой.
 */
const at = new Date("2026-09-07T18:12:00Z");

describe("последнее общение", () => {
  it("входящее SMS — слова клиента", () => {
    const r = describeContact({ direction: "INBOUND", type: "SMS", status: "RECEIVED", messageText: "Thanks, will do", transcript: null, summary: null, occurredAt: at });
    expect(r.who).toBe("клиент написал");
    expect(r.text).toBe("Thanks, will do");
  });

  it("исходящее SMS — что написали мы", () => {
    const r = describeContact({ direction: "OUTBOUND", type: "SMS", status: "DELIVERED", messageText: "Please leave a review", transcript: null, summary: null, occurredAt: at });
    expect(r.who).toBe("мы написали");
  });

  it("пропущенный звонок виден как пропущенный, даже без расшифровки", () => {
    const r = describeContact({ direction: "INBOUND", type: "CALL", status: "MISSED", messageText: null, transcript: null, summary: null, occurredAt: at });
    expect(r.who).toBe("пропущенный звонок от клиента");
    expect(r.text).toBeNull();
  });

  it("состоявшийся звонок показывает расшифровку", () => {
    const r = describeContact({ direction: "INBOUND", type: "CALL", status: "COMPLETED", messageText: null, transcript: "I already left the review", summary: null, occurredAt: at });
    expect(r.who).toBe("звонок от клиента");
    expect(r.text).toBe("I already left the review");
  });

  it("длинный текст обрезается, чтобы карточка осталась карточкой", () => {
    const r = describeContact({ direction: "INBOUND", type: "SMS", status: "RECEIVED", messageText: "x".repeat(400), transcript: null, summary: null, occurredAt: at });
    expect(r.text).toHaveLength(240);
  });
});
