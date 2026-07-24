/**
 * AirwallexClient: контракт с Payments API (сеть замокана). Эндпоинты и статусы — по
 * официальной документации: login (x-client-id/x-api-key → token), GET payment_intents/{id}.
 * Проверяем то, что нельзя увидеть глазами: кэш токена, re-auth на 401, backoff на 429,
 * маппинг статусов, и что credentials/токен не утекают.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { AirwallexClient } from "./client";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);
const reply = (status: number, body: unknown) => ({ status, json: async () => body });
const creds = { clientId: "cid", apiKey: "akey", env: "prod" as const };

beforeEach(() => fetchMock.mockReset());

describe("авторизация", () => {
  it("login отправляет x-client-id/x-api-key на нужный эндпоинт", async () => {
    fetchMock.mockResolvedValueOnce(reply(201, { token: "tok", expires_at: new Date(Date.now() + 30 * 60000).toISOString() }));
    const r = await new AirwallexClient(creds).verify();
    expect(r).toEqual({ ok: true, accountName: null });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://api.airwallex.com/api/v1/authentication/login");
    expect(init.headers["x-client-id"]).toBe("cid");
    expect(init.headers["x-api-key"]).toBe("akey");
  });

  it("demo-окружение бьёт по api-demo", async () => {
    fetchMock.mockResolvedValueOnce(reply(201, { token: "t", expires_at: new Date(Date.now() + 1800_000).toISOString() }));
    await new AirwallexClient({ ...creds, env: "demo" }).verify();
    expect(String(fetchMock.mock.calls[0][0])).toContain("https://api-demo.airwallex.com");
  });

  it("401 на login → unauthorized", async () => {
    fetchMock.mockResolvedValueOnce(reply(401, {}));
    expect(await new AirwallexClient(creds).verify()).toEqual({ ok: false, code: "unauthorized" });
  });

  it("токен переиспользуется — второй запрос не логинится заново", async () => {
    fetchMock
      .mockResolvedValueOnce(reply(201, { token: "tok", expires_at: new Date(Date.now() + 30 * 60000).toISOString() }))
      .mockResolvedValueOnce(reply(200, { status: "SUCCEEDED" }))
      .mockResolvedValueOnce(reply(200, { status: "PENDING" }));
    const c = new AirwallexClient(creds);
    await c.getPaymentIntent("int_1");
    await c.getPaymentIntent("int_2");
    const logins = fetchMock.mock.calls.filter((c) => String(c[0]).includes("/authentication/login"));
    expect(logins).toHaveLength(1); // один login на два запроса
  });
});

describe("getPaymentIntent — статусы", () => {
  const login = () => reply(201, { token: "tok", expires_at: new Date(Date.now() + 30 * 60000).toISOString() });

  it("SUCCEEDED нормализуется, отдаёт raw и latest_payment_attempt", async () => {
    fetchMock.mockResolvedValueOnce(login()).mockResolvedValueOnce(reply(200, { status: "SUCCEEDED", amount: 175.31, currency: "USD", captured_amount: 175.31, latest_payment_attempt: { status: "CAPTURED" } }));
    const r = await new AirwallexClient(creds).getPaymentIntent("int_1");
    expect(r).toMatchObject({ ok: true, found: true, status: "SUCCEEDED", rawStatus: "SUCCEEDED", latestAttemptStatus: "CAPTURED", capturedAmount: 175.31 });
  });

  it("незнакомый статус → UNKNOWN (не гадаем)", async () => {
    fetchMock.mockResolvedValueOnce(login()).mockResolvedValueOnce(reply(200, { status: "SOME_NEW_STATE" }));
    const r = await new AirwallexClient(creds).getPaymentIntent("int_1");
    expect(r).toMatchObject({ ok: true, found: true, status: "UNKNOWN", rawStatus: "SOME_NEW_STATE" });
  });

  it("404 → not found", async () => {
    fetchMock.mockResolvedValueOnce(login()).mockResolvedValueOnce(reply(404, { code: "not_found" }));
    expect(await new AirwallexClient(creds).getPaymentIntent("int_x")).toEqual({ ok: true, found: false });
  });

  it("401 в запросе → один re-auth и повтор", async () => {
    fetchMock
      .mockResolvedValueOnce(login())
      .mockResolvedValueOnce(reply(401, {}))       // токен протух
      .mockResolvedValueOnce(login())              // re-auth
      .mockResolvedValueOnce(reply(200, { status: "PENDING" }));
    const r = await new AirwallexClient(creds).getPaymentIntent("int_1");
    expect(r).toMatchObject({ ok: true, found: true, status: "PENDING" });
    expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes("/authentication/login"))).toHaveLength(2);
  });

  it("429 → backoff и повтор", async () => {
    fetchMock
      .mockResolvedValueOnce(login())
      .mockResolvedValueOnce(reply(429, {}))
      .mockResolvedValueOnce(reply(200, { status: "SUCCEEDED" }));
    const r = await new AirwallexClient(creds).getPaymentIntent("int_1");
    expect(r).toMatchObject({ ok: true, status: "SUCCEEDED" });
  });

  it("5xx → retryable, но не падаем", async () => {
    fetchMock.mockResolvedValueOnce(login()).mockResolvedValueOnce(reply(503, {}));
    expect(await new AirwallexClient(creds).getPaymentIntent("int_1")).toMatchObject({ ok: false, retryable: true });
  });

  it("токен и credentials не встречаются в результате", async () => {
    fetchMock.mockResolvedValueOnce(login()).mockResolvedValueOnce(reply(200, { status: "SUCCEEDED" }));
    const r = await new AirwallexClient(creds).getPaymentIntent("int_1");
    const dump = JSON.stringify(r);
    expect(dump).not.toContain("tok");
    expect(dump).not.toContain("akey");
    expect(dump).not.toContain("cid");
  });
});
