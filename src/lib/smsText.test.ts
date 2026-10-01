import { describe, it, expect } from "vitest";
import { toSmsText, smsSegments, isGsm7, stripDashes } from "./smsText";

/**
 * Очистка SMS перед отправкой через Quo: один символ вне GSM-7 переводит всё сообщение в части
 * по 70 знаков вместо 160 — и счёт вырастает в 2–2,5 раза.
 */
describe("текст SMS — базовым алфавитом", () => {
  it("типографика → простые знаки", () => {
    expect(toSmsText("what’s the apartment unit? “Ring twice”…")).toBe(`what's the apartment unit? "Ring twice"...`);
    expect(toSmsText("between 7–8 PM")).toBe("between 7-8 PM");
    expect(toSmsText("a reminder — it only takes a minute")).toBe("a reminder, it only takes a minute");
    expect(toSmsText("• fresh water\n• cool place")).toBe("- fresh water\n- cool place");
    expect(toSmsText("Hi\u{00A0}Anna,\u{200B} see you")).toBe("Hi Anna, see you");
  });

  it("эмодзи убираются без лишних пробелов", () => {
    expect(toSmsText("Thank you🙏🏻")).toBe("Thank you");
    expect(toSmsText("Got it, 402 👍")).toBe("Got it, 402");
    expect(toSmsText("Sure, we'll bring it tomorrow 🌸!")).toBe("Sure, we'll bring it tomorrow!");
    expect(toSmsText("receive the bouquet? ☺️🙏")).toBe("receive the bouquet?");
    expect(toSmsText("Love 💖 it, 👨‍👩‍👧 family 🇺🇸")).toBe("Love it, family");
  });

  it("буквы с диакритикой вне GSM — без неё, буквы из GSM остаются", () => {
    expect(toSmsText("Hi María, Sofía and Ramón")).toBe("Hi Maria, Sofia and Ramon");
    expect(toSmsText("José, Muñoz, Müller, café, Françoise")).toBe("José, Muñoz, Müller, café, Francoise");
    // Разложенная «e + ударение» сначала собирается в é (она в GSM).
    expect(toSmsText("cafe\u{0301}")).toBe("café");
    expect(toSmsText("Łukasz")).toBe("Lukasz");
  });

  it("чужой алфавит не трогаем: его не заменить без потери смысла", () => {
    expect(toSmsText("Привет")).toBe("Привет");
  });

  it("простой английский не меняется", () => {
    const plain = "Hi Sarah, your bouquet is on the way: https://tracking.burqup.com/orders/track/o_abc";
    expect(toSmsText(plain)).toBe(plain);
  });

  it("после очистки текст снова влезает в части по 160", () => {
    const owner = "Good afternoon, this is flowers delivery! We have a delivery set for you for today, what is the best time for us to deliver it? And what’s the apartment unit? Thank you🙏🏻";
    expect(smsSegments(owner)).toEqual({ encoding: "UCS-2", segments: 3 });
    const clean = toSmsText(owner);
    expect(isGsm7(clean)).toBe(true);
    expect(smsSegments(clean)).toEqual({ encoding: "GSM-7", segments: 2 });
  });

  it("части: 160 латиницей, 153 в длинном; 70 и 67 в Unicode; € — за два знака", () => {
    expect(smsSegments("a".repeat(160))).toEqual({ encoding: "GSM-7", segments: 1 });
    expect(smsSegments("a".repeat(161))).toEqual({ encoding: "GSM-7", segments: 2 });
    expect(smsSegments("a".repeat(306))).toEqual({ encoding: "GSM-7", segments: 2 });
    expect(smsSegments("a".repeat(307))).toEqual({ encoding: "GSM-7", segments: 3 });
    expect(smsSegments("€".repeat(80))).toEqual({ encoding: "GSM-7", segments: 1 });
    expect(smsSegments("’" + "a".repeat(69))).toEqual({ encoding: "UCS-2", segments: 1 });
    expect(smsSegments("’" + "a".repeat(70))).toEqual({ encoding: "UCS-2", segments: 2 });
    expect(smsSegments("")).toEqual({ encoding: "GSM-7", segments: 0 });
  });

  it("длинные тире: диапазон цифр — дефис, остальное — запятая", () => {
    expect(stripDashes("Got it — we'll be there by 2 PM — see you!")).toBe("Got it, we'll be there by 2 PM, see you!");
    expect(stripDashes("The window is 2–4 PM.")).toBe("The window is 2-4 PM.");
    expect(stripDashes("Sure —.")).toBe("Sure.");
    expect(stripDashes("— On it.")).toBe("On it.");
  });
});
