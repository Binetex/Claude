import { describe, it, expect, vi } from "vitest";
import { mintClientCredentialsToken, needsRefresh, ShopifyAuthError, TOKEN_REFRESH_BUFFER_MS } from "./tokenClient";

const T0 = new Date("2026-07-18T00:00:00Z");
const now = () => T0;

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const params = { shopDomain: "demo.myshopify.com", clientId: "cid", clientSecret: "csecret" };

describe("mintClientCredentialsToken", () => {
  it("успех: возвращает токен и вычисляет expiresAt (now + expires_in)", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const fetchImpl = vi.fn((url: string, init: RequestInit) => {
      capturedUrl = url;
      capturedInit = init;
      return Promise.resolve(jsonResponse(200, { access_token: "shpat_abc", expires_in: 86399 }));
    });
    const t = await mintClientCredentialsToken(params, fetchImpl, now);
    expect(t.accessToken).toBe("shpat_abc");
    expect(t.expiresIn).toBe(86399);
    expect(t.expiresAt.getTime()).toBe(T0.getTime() + 86399 * 1000);

    // Проверяем корректность запроса (endpoint, content-type, grant_type).
    expect(capturedUrl).toBe("https://demo.myshopify.com/admin/oauth/access_token");
    expect((capturedInit!.headers as Record<string, string>)["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(String(capturedInit!.body)).toContain("grant_type=client_credentials");
    expect(String(capturedInit!.body)).toContain("client_id=cid");
  });

  it("по умолчанию expires_in = 86399, если не пришёл", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { access_token: "shpat_x" }));
    const t = await mintClientCredentialsToken(params, fetchImpl, now);
    expect(t.expiresIn).toBe(86399);
  });

  it("401 → ShopifyAuthError invalid_client, requiresReauth=true", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(401, { error: "invalid_client" }));
    await expect(mintClientCredentialsToken(params, fetchImpl, now)).rejects.toMatchObject({
      name: "ShopifyAuthError",
      kind: "invalid_client",
      requiresReauth: true,
    });
  });

  it("400 invalid_request (напр. не same-org) → invalid_client (reauth)", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(400, { error: "invalid_request", error_description: "app and store must be in the same organization" }));
    const err = await mintClientCredentialsToken(params, fetchImpl, now).catch((e) => e);
    expect(err).toBeInstanceOf(ShopifyAuthError);
    expect(err.requiresReauth).toBe(true);
  });

  it("500 → http-ошибка (не reauth, повтор допустим)", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(500, { error: "server" }));
    const err = await mintClientCredentialsToken(params, fetchImpl, now).catch((e) => e);
    expect(err).toBeInstanceOf(ShopifyAuthError);
    expect(err.kind).toBe("http");
    expect(err.requiresReauth).toBe(false);
  });

  it("нет access_token → parse-ошибка", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { expires_in: 86399 }));
    await expect(mintClientCredentialsToken(params, fetchImpl, now)).rejects.toMatchObject({ kind: "parse" });
  });

  it("не логирует client_secret в тексте ошибки", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(401, { error: "invalid_client" }));
    const err = await mintClientCredentialsToken({ ...params, clientSecret: "TOP_SECRET_VALUE" }, fetchImpl, now).catch((e) => e);
    expect(String(err.message)).not.toContain("TOP_SECRET_VALUE");
  });
});

describe("needsRefresh", () => {
  it("true, если токена нет", () => expect(needsRefresh(null, T0)).toBe(true));
  it("true, если истекает в пределах буфера", () => {
    const soon = new Date(T0.getTime() + TOKEN_REFRESH_BUFFER_MS - 1000);
    expect(needsRefresh(soon, T0)).toBe(true);
  });
  it("false, если ещё долго жить", () => {
    const later = new Date(T0.getTime() + 3600 * 1000);
    expect(needsRefresh(later, T0)).toBe(false);
  });
});
