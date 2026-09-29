import { describe, it, expect } from "vitest";
import { emailQuoteForTelegram, emailNewText, isAutoReply } from "./ingest";

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

describe("новый текст письма для ассистента", () => {
  it("без цитаты и без подписи почтового приложения", () => {
    // THEFLOW-20861, 28.09.2026 — ответ клиента из Outlook на наше письмо.
    const text = "Im Jorge Batarse my phone nombre is +52 8712647484\n\nGet Outlook for iOS<https://aka.ms/o0ukef>\n________________________________\nFrom: The Flow <client@theflow.la>\nSent: Monday";
    expect(emailNewText(text)).toBe("Im Jorge Batarse my phone nombre is +52 8712647484");
    expect(emailNewText("Sounds good!\n\nSent from my iPhone")).toBe("Sounds good!");
  });

  it("письмо из одной цитаты — нового нет", () => {
    expect(emailNewText("> only quoted text here")).toBe("");
  });

  it("шапку Gmail, перенесённую на вторую строку, тоже режет", () => {
    // Длинные имя с адресом Gmail переносит, и «wrote:» уезжает вниз. Без этого «спасибо» с
    // хвостом «On Mon, Sep 28, 2026 at 5:12 PM …» не считалось вежливостью, а «5:12 PM» из
    // шапки сходило за время, которое назвал клиент.
    const text = [
      "Thank you!", "",
      "On Mon, Sep 28, 2026 at 5:12 PM The Flow Los Angeles <client@theflow.la>", "wrote:", "",
      "> Hi Jorge, your flowers were delivered.",
    ].join("\n");
    expect(emailNewText(text)).toBe("Thank you!");
  });
});

describe("письма почтовых роботов", () => {
  it("автоответ узнаётся по теме, по тексту и по адресу", () => {
    expect(isAutoReply({ fromEmail: "anna@example.com", subject: "Automatic reply: Re: Order JF-1001380", text: "Thanks for your email." })).toBe(true);
    expect(isAutoReply({ fromEmail: "anna@example.com", subject: "Re: Order JF-1001380", text: "I am currently out of the office until Monday." })).toBe(true);
    expect(isAutoReply({ fromEmail: "MAILER-DAEMON@mx.example.com", subject: "Undeliverable: Order JF-1001380", text: "Delivery has failed." })).toBe(true);
    expect(isAutoReply({ fromEmail: "noreply@shop.example", subject: "Your receipt", text: "Paid." })).toBe(true);
  });

  it("живое письмо — не автоответ, даже с автоответом в цитате ниже", () => {
    expect(isAutoReply({ fromEmail: "anna@example.com", subject: "Re: Order JF-1001380", text: "Can you deliver after 5?" })).toBe(false);
    const quoted = "Please bring it to my office after 5.\n\nOn Mon, Sep 28, 2026 at 5:12 PM JF <client@jf.example> wrote:\n> This is an automated message.";
    expect(isAutoReply({ fromEmail: "anna@example.com", subject: "Re: Order JF-1001380", text: quoted })).toBe(false);
  });
});
