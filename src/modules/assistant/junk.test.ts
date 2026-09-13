import { describe, it, expect } from "vitest";
import { junkReason } from "./junk";

describe("junkReason", () => {
  it("ловит рассылки о финансировании — на них уходил живой ответ", () => {
    expect(junkReason("Hi Emanouel! It's Elli from Fast Biz Funds. I have pre-approved for 100k Payback 118K. Interested?")).toBe("spam_rule");
    expect(junkReason("Hey, it's Jacob. I can either pay off any position you have at a better term or provide new capital.")).toBe("spam_rule");
  });

  it("ловит автоответы операторов", () => {
    expect(junkReason("We do not monitor this line for text messages.")).toBe("service_rule");
    expect(junkReason("Your verification code is 445512")).toBe("service_rule");
  });

  it("живые сообщения клиентов не трогает", () => {
    expect(junkReason("Can you deliver after 5pm?")).toBeNull();
    expect(junkReason("Hi, I'd like to order a bouquet of red roses for tomorrow")).toBeNull();
    expect(junkReason("The gate code is #2846, please leave it at the front door")).toBeNull();
    expect(junkReason("")).toBeNull();
  });
});
