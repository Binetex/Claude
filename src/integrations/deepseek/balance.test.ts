import { describe, it, expect, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { fetchModelBalance } from "./balance";

const cfg = (baseUrl: string) => ({ apiKey: "k", baseUrl, model: "deepseek-chat" });
const jsonRes = (body: unknown, status = 200) =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe("остаток на аккаунте модели", () => {
  it("DeepSeek: разбирает ответ провайдера", async () => {
    const f = jsonRes({ is_available: true, balance_infos: [{ currency: "USD", total_balance: "2.40" }] });
    expect(await fetchModelBalance(cfg("https://api.deepseek.com"), f)).toEqual({
      supported: true, available: true, currency: "USD", total: "2.40",
    });
  });

  it("аккаунт помечен недоступным — это видно", async () => {
    const f = jsonRes({ is_available: false, balance_infos: [{ currency: "USD", total_balance: "0.00" }] });
    const r = await fetchModelBalance(cfg("https://api.deepseek.com"), f);
    expect(r).toMatchObject({ supported: true, available: false, total: "0.00" });
  });

  it("OpenAI и прочие: честно говорим, что остаток по API не отдаётся", async () => {
    const called = vi.fn();
    const r = await fetchModelBalance(cfg("https://api.openai.com/v1"), called as unknown as typeof fetch);
    expect(r).toMatchObject({ supported: false });
    expect(called).not.toHaveBeenCalled(); // чужой адрес не дёргаем вовсе
  });

  it("похожий, но чужой домен не принимаем за DeepSeek", async () => {
    const called = vi.fn();
    const r = await fetchModelBalance(cfg("https://api.deepseek.com.evil.example"), called as unknown as typeof fetch);
    expect(r).toMatchObject({ supported: false });
    expect(called).not.toHaveBeenCalled();
  });

  it("провайдер ответил ошибкой — страница не падает", async () => {
    expect(await fetchModelBalance(cfg("https://api.deepseek.com"), jsonRes({}, 401))).toMatchObject({ supported: false });
  });

  it("сеть недоступна — страница не падает", async () => {
    const f = (async () => { throw new Error("network"); }) as unknown as typeof fetch;
    expect(await fetchModelBalance(cfg("https://api.deepseek.com"), f)).toMatchObject({ supported: false });
  });
});
