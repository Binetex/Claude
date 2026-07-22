import { describe, it, expect } from "vitest";
import { escapeHtml, normalizeCardMessage, isBlankCardMessage, CARD_MESSAGE_MAX } from "./cardText";

describe("cardText", () => {
  it("escapeHtml не даёт исполнять HTML", () => {
    expect(escapeHtml('<script>alert("x")</script>')).toBe("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    expect(escapeHtml("A & B")).toBe("A &amp; B");
  });

  it("normalizeCardMessage: CRLF→LF, обрезка хвостовых пробелов, лимит 10000", () => {
    expect(normalizeCardMessage("a\r\nb")).toBe("a\nb");
    expect(normalizeCardMessage("line   \n  next")).toBe("line\n  next"); // хвостовые убраны, ведущие сохранены
    expect(normalizeCardMessage("x".repeat(CARD_MESSAGE_MAX + 500)).length).toBe(CARD_MESSAGE_MAX);
  });

  it("сохраняет переносы строк (внутренние \\n не теряются)", () => {
    expect(normalizeCardMessage("a\n\nb")).toBe("a\n\nb");
  });

  it("isBlankCardMessage", () => {
    expect(isBlankCardMessage("")).toBe(true);
    expect(isBlankCardMessage("   \n ")).toBe(true);
    expect(isBlankCardMessage(null)).toBe(true);
    expect(isBlankCardMessage("hi")).toBe(false);
  });
});
