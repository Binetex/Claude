/**
 * TelegramSender: поведение относительно Bot API. Сеть замокана — проверяем именно контракт
 * обработки ответов, из-за которого уведомления либо дублируются, либо теряются.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { TelegramSender } from "./sender";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);
afterEach(() => fetchMock.mockReset());

const reply = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });

describe("sendMessage", () => {
  it("успех → message_id возвращается строкой (в БД не храним как number)", async () => {
    fetchMock.mockResolvedValueOnce(reply({ ok: true, result: { message_id: 12345 } }));
    const r = await new TelegramSender("t").sendMessage("-100123", "текст");
    expect(r).toEqual({ ok: true, messageId: "12345" });
  });

  it("chat_id уходит как есть, без приведения к number", async () => {
    // id супергруппы — большое отрицательное число; храним и передаём строкой,
    // чтобы нигде не потерять точность.
    fetchMock.mockResolvedValueOnce(reply({ ok: true, result: { message_id: 1 } }));
    await new TelegramSender("t").sendMessage("-1001234567890123", "текст");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).chat_id).toBe("-1001234567890123");
  });

  it("кнопки уходят одним рядом inline_keyboard", async () => {
    fetchMock.mockResolvedValueOnce(reply({ ok: true, result: { message_id: 1 } }));
    await new TelegramSender("t").sendMessage("-100", "текст", [
      { text: "Open Order", url: "https://x/y" },
      { text: "📍 Google Maps", url: "https://maps/z" },
    ]);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.reply_markup.inline_keyboard[0]).toEqual([
      { text: "Open Order", url: "https://x/y" },
      { text: "📍 Google Maps", url: "https://maps/z" },
    ]);
  });

  it("sendPhoto шлёт фото с подписью и кнопками", async () => {
    fetchMock.mockResolvedValueOnce(reply({ ok: true, result: { message_id: 77 } }));
    const r = await new TelegramSender("t").sendPhoto("-100", "https://cdn/x.jpg", "подпись", [{ text: "Open", url: "https://o" }]);
    expect(r).toEqual({ ok: true, messageId: "77" });
    expect(String(fetchMock.mock.calls[0][0])).toContain("/sendPhoto");
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.photo).toBe("https://cdn/x.jpg");
    expect(body.caption).toBe("подпись");
  });

  it("editMessageCaption правит подпись фото-сообщения", async () => {
    fetchMock.mockResolvedValueOnce(reply({ ok: true, result: {} }));
    expect(await new TelegramSender("t").editMessageCaption("-100", "77", "новая", [])).toEqual({ ok: true });
    expect(String(fetchMock.mock.calls[0][0])).toContain("/editMessageCaption");
  });

  it("429 → ждём retry_after и повторяем", async () => {
    fetchMock
      .mockResolvedValueOnce(reply({ ok: false, error_code: 429, parameters: { retry_after: 0 } }, 429))
      .mockResolvedValueOnce(reply({ ok: true, result: { message_id: 5 } }));
    const r = await new TelegramSender("t").sendMessage("-100", "текст");
    expect(r).toEqual({ ok: true, messageId: "5" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("постоянная ошибка (403) → не retryable, безопасный код без описания провайдера", async () => {
    fetchMock.mockResolvedValue(reply({ ok: false, error_code: 403, description: "bot was blocked by the user" }, 403));
    const r = await new TelegramSender("t").sendMessage("-100", "текст");
    expect(r).toMatchObject({ ok: false, retryable: false, code: "telegram_403" });
  });
});

describe("editMessage", () => {
  it("400 «message is not modified» считается УСПЕХОМ", async () => {
    fetchMock.mockResolvedValue(reply({ ok: false, error_code: 400, description: "Bad Request: message is not modified" }, 400));
    expect(await new TelegramSender("t").editMessage("-100", "7", "текст")).toEqual({ ok: true });
  });

  it("сообщение удалено → needsResend, чтобы отправить новое", async () => {
    fetchMock.mockResolvedValue(reply({ ok: false, error_code: 400, description: "Bad Request: message to edit not found" }, 400));
    expect(await new TelegramSender("t").editMessage("-100", "7", "текст")).toEqual({ ok: false, needsResend: true });
  });

  it("сетевой сбой → retryable, обработчик отдаст событие на повтор в outbox", async () => {
    fetchMock.mockRejectedValue(new Error("boom"));
    const r = await new TelegramSender("t").editMessage("-100", "7", "текст");
    expect(r).toMatchObject({ ok: false, retryable: true });
  });
});
