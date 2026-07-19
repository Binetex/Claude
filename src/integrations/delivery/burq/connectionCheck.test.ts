import { describe, it, expect, vi, afterEach } from "vitest";
import { checkBurqAuth } from "./client";

/** checkBurqAuth — безопасный read-only GET /orders?limit=1; заказы не создаются. */
describe("checkBurqAuth", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("200 → ok, вызывает GET /orders?limit=1 с x-api-key, без POST/DELETE", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
    const r = await checkBurqAuth({ apiKey: "sk_test_x", baseUrl: "https://api.burqup.com/v2" });
    expect(r).toEqual({ ok: true, status: 200, safeMessage: "ok" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.burqup.com/v2/orders?limit=1");
    expect(init.method).toBe("GET");
    expect(init.headers["x-api-key"]).toBe("sk_test_x");
  });

  it("401 → not ok, unauthorized-подобный статус; сообщение без секрета", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401 }));
    const r = await checkBurqAuth({ apiKey: "sk_bad", baseUrl: "https://api.burqup.com/v2" });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(401);
    expect(r.safeMessage).not.toContain("sk_bad");
  });

  it("сетевая ошибка → ok=false, только тип ошибки (без URL/секрета)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed to secret-host")));
    const r = await checkBurqAuth({ apiKey: "sk_secret", baseUrl: "https://api.burqup.com/v2" });
    expect(r.ok).toBe(false);
    expect(r.safeMessage).toBe("TypeError");
    expect(r.safeMessage).not.toContain("sk_secret");
    expect(r.safeMessage).not.toContain("secret-host");
  });
});
