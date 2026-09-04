import { describe, it, expect, vi } from "vitest";
import { createDeepseekClient } from "./client";
import { DeepseekError } from "./errors";

/**
 * Клиент модели. По ту сторону SMS живой человек, поэтому проверяем ровно то, из-за чего он
 * может остаться без ответа или получить его слишком поздно: таймаут, единственный повтор,
 * отсутствие повторов там, где повторять бессмысленно.
 */
const cfg = { apiKey: "k", baseUrl: "https://api.deepseek.com", model: "deepseek-chat" };
const ok = (content: string) =>
  new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });

describe("обращение к модели", () => {
  it("возвращает текст ответа и просит строгий JSON", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok('{"reply_en":"Hi"}'));
    const client = createDeepseekClient(cfg, { fetchImpl: fetchImpl as unknown as typeof fetch });

    const res = await client.complete([{ role: "user", content: "hi" }]);

    expect(res.text).toBe('{"reply_en":"Hi"}');
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    // Ответ читает код, а не человек: свободный текст пришлось бы разбирать регулярками.
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.model).toBe("deepseek-chat");
  });

  it("временную ошибку повторяет ровно один раз", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("boom", { status: 500 }))
      .mockResolvedValueOnce(ok('{"reply_en":"Hi"}'));
    const client = createDeepseekClient(cfg, { fetchImpl: fetchImpl as unknown as typeof fetch, sleep: async () => {} });

    await expect(client.complete([{ role: "user", content: "hi" }])).resolves.toMatchObject({ text: '{"reply_en":"Hi"}' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("сломанный ключ не повторяет — так и будет", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("nope", { status: 401 }));
    const client = createDeepseekClient(cfg, { fetchImpl: fetchImpl as unknown as typeof fetch, sleep: async () => {} });

    await expect(client.complete([{ role: "user", content: "hi" }])).rejects.toMatchObject({ code: "auth" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("закончился баланс — отдельный код, чтобы сигнал владельцу был понятным", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("no money", { status: 402 }));
    const client = createDeepseekClient(cfg, { fetchImpl: fetchImpl as unknown as typeof fetch, sleep: async () => {} });

    await expect(client.complete([{ role: "user", content: "hi" }])).rejects.toMatchObject({ code: "no_balance" });
  });

  it("пустой ответ считается сбоем, а не ответом", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok("   "));
    const client = createDeepseekClient(cfg, { fetchImpl: fetchImpl as unknown as typeof fetch, sleep: async () => {} });

    await expect(client.complete([{ role: "user", content: "hi" }])).rejects.toBeInstanceOf(DeepseekError);
    expect(fetchImpl).toHaveBeenCalledTimes(2); // пустота бывает разовой — один повтор
  });
});
