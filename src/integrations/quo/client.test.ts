import { describe, it, expect, vi } from "vitest";
import { createQuoClient } from "./client";
import { QuoApiError } from "./errors";

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(body === null ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

const cfg = (fetchImpl: typeof fetch, over: Partial<Parameters<typeof createQuoClient>[0]> = {}) => ({
  apiKey: "op_test_key", baseUrl: "https://api.openphone.com/v1", fetchImpl, sleep: async () => {}, maxRetries: 3, baseDelayMs: 1, ...over,
});

describe("QuoClient", () => {
  it("sendMessage: raw Authorization header, тело, разворачивает data", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>).Authorization).toBe("op_test_key"); // сырой ключ, НЕ Bearer
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({ content: "Hi", from: "PN1", to: ["+13105551234"] });
      return jsonResponse(202, { data: { id: "AC1", status: "queued", conversationId: "CN1", from: "PN1", to: ["+13105551234"] } });
    });
    const client = createQuoClient(cfg(fetchImpl as unknown as typeof fetch));
    const res = await client.sendMessage({ content: "Hi", from: "PN1", to: ["+13105551234"] });
    expect(res).toEqual({ id: "AC1", status: "queued", conversationId: "CN1", from: "PN1", to: ["+13105551234"] });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("401 → QuoApiError kind=auth, БЕЗ ретрая", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(401, { code: "unauthorized" }));
    const client = createQuoClient(cfg(fetchImpl as unknown as typeof fetch));
    await expect(client.getCall("AC1")).rejects.toMatchObject({ kind: "auth", status: 401 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("429 → ретраится и в итоге бросает rate_limit", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(429, { code: "rate_limited" }, { "retry-after": "0" }));
    const client = createQuoClient(cfg(fetchImpl as unknown as typeof fetch, { maxRetries: 2 }));
    await expect(client.getCall("AC1")).rejects.toMatchObject({ kind: "rate_limit", retryable: true });
    expect(fetchImpl).toHaveBeenCalledTimes(3); // 1 + 2 повтора
  });

  it("429 затем 200 → успех после ретрая", async () => {
    let n = 0;
    const fetchImpl = vi.fn(async () => (++n === 1 ? jsonResponse(429, {}, { "retry-after": "0" }) : jsonResponse(200, { data: { id: "AC1", status: "completed" } })));
    const client = createQuoClient(cfg(fetchImpl as unknown as typeof fetch));
    await expect(client.getCall("AC1")).resolves.toMatchObject({ id: "AC1" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("500 → ретраится (временный 5xx) и бросает server", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(500, {}));
    const client = createQuoClient(cfg(fetchImpl as unknown as typeof fetch, { maxRetries: 1 }));
    await expect(client.getCall("AC1")).rejects.toMatchObject({ kind: "server" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("404 на getCallTranscript → null (graceful, plan-gated)", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(404, {}));
    const client = createQuoClient(cfg(fetchImpl as unknown as typeof fetch));
    await expect(client.getCallTranscript("AC1")).resolves.toBeNull();
  });

  it("403 на getCallSummary → null (Business/Scale only)", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(403, {}));
    const client = createQuoClient(cfg(fetchImpl as unknown as typeof fetch));
    await expect(client.getCallSummary("AC1")).resolves.toBeNull();
  });

  it("сетевой сбой → ретрай и network error", async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError("fetch failed"); });
    const client = createQuoClient(cfg(fetchImpl as unknown as typeof fetch, { maxRetries: 2 }));
    await expect(client.getCall("AC1")).rejects.toBeInstanceOf(QuoApiError);
    await expect(client.getCall("AC1")).rejects.toMatchObject({ kind: "network", retryable: true });
  });

  it("400 → client error, НЕ ретраится", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(400, { code: "bad_request" }));
    const client = createQuoClient(cfg(fetchImpl as unknown as typeof fetch));
    await expect(client.sendMessage({ content: "x", from: "PN1", to: ["+1"] })).rejects.toMatchObject({ kind: "client", retryable: false });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
