import { describe, it, expect } from "vitest";
import { emailQuoteForTelegram } from "./ingest";

/**
 * Письма взяты с прода 21.09.2026. Почтовые клиенты подклеивают к ответу всё прошлое письмо,
 * и без обрезки уведомление в Telegram состояло бы из нашего же текста, а две строки, ради
 * которых клиент писал, оказались бы за экраном.
 */
describe("текст письма для Telegram", () => {
  it("режет цитату Gmail «On … wrote:»", () => {
    const text = [
      "Hi,", "", "Try +61 421 254 672", "",
      "I’m here from Australia, so the number was missing the Australian region code (61).", "",
      "On Mon, 21 Sep 2026 at 8:54 am, JF <client@juliesflowers.net> wrote:", "",
      "> It looks like there may be a mistake in the phone number",
    ].join("\n");
    const out = emailQuoteForTelegram(text);
    expect(out).toContain("+61 421 254 672");
    expect(out).not.toContain("wrote:");
    expect(out).not.toContain(">");
  });

  it("режет цитату Outlook по разделителю и «From:»", () => {
    const text = "Hey!\n\nThe code is #1826, it is apartment 16.\n________________________________\nFrom: The Flow <client@theflow.la>\nSent: Sunday";
    const out = emailQuoteForTelegram(text);
    expect(out).toBe("Hey!\n\nThe code is #1826, it is apartment 16.");
  });

  it("письмо без цитаты не трогает", () => {
    expect(emailQuoteForTelegram("Yes, that works. Thank you!")).toBe("Yes, that works. Thank you!");
  });

  it("длинное письмо обрезает и помечает многоточием", () => {
    const out = emailQuoteForTelegram("a".repeat(900), 100);
    expect(out).toHaveLength(101);
    expect(out.endsWith("…")).toBe(true);
  });

  it("строка, начинающаяся с цитаты, не превращается в пустоту", () => {
    // cut === 0: резать нечего, иначе в Telegram ушло бы пустое уведомление.
    const out = emailQuoteForTelegram("> only quoted text here");
    expect(out).toBe("> only quoted text here");
  });
});
