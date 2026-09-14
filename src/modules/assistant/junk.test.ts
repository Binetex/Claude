import { describe, it, expect } from "vitest";
import { junkReason } from "./junk";

describe("junkReason", () => {
  it("ловит рассылки о финансировании — на них уходил живой ответ", () => {
    expect(junkReason("Hi Emanouel! It's Elli from Fast Biz Funds. I have pre-approved for 100k Payback 118K. Interested?", false)).toBe("spam_rule");
    expect(junkReason("Hey, it's Jacob. I can either pay off any position you have at a better term or provide new capital.", false)).toBe("spam_rule");
    expect(junkReason("Business funding up to $500K at competitive rates. Reply GO to get started.", false)).toBe("spam_rule");
  });

  it("ловит автоответы операторов", () => {
    expect(junkReason("We do not monitor this line for text messages.", false)).toBe("service_rule");
    expect(junkReason("Your verification code is 445512", false)).toBe("service_rule");
  });

  it("переписку по заказу не трогает НИКОГДА: цена ошибки там — сорванная доставка", () => {
    expect(junkReason("We do not monitor this line for text messages.", true)).toBeNull();
    expect(junkReason("Please unsubscribe me", true)).toBeNull();
  });

  it("код домофона — это клиент, а не служебное сообщение", () => {
    for (const t of [
      "The gate code is 4455",
      "the door code is 1234, leave them inside",
      "Gate code is 2846 and my apartment is 12B",
      "The building code is 9081",
    ]) {
      expect(junkReason(t, false), t).toBeNull();
    }
  });

  it("слова живых клиентов не считаются рассылкой", () => {
    for (const t of [
      "what is your best email so I can send a picture of the arrangement",
      "Do you offer financing for a large wedding order?",
      "Please fill out our intake form before delivery, this is Rose Hills funeral home",
      "my budget is up to 2k",
      "Is this an automated message or a real person?",
    ]) {
      expect(junkReason(t, false), t).toBeNull();
    }
  });

  it("живые сообщения клиентов не трогает", () => {
    expect(junkReason("Can you deliver after 5pm?", false)).toBeNull();
    expect(junkReason("Hi, I'd like to order a bouquet of red roses for tomorrow", false)).toBeNull();
    expect(junkReason("", false)).toBeNull();
  });
});
