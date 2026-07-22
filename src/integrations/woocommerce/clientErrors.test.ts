import { describe, it, expect, vi } from "vitest";
import { classifyWooHttpError, htmlLooking, WooApiError } from "./clientErrors";
import { wooRequest } from "./client";
import type { WooCredentials } from "./credentials";

const creds: WooCredentials = {
  siteId: "s1",
  storeUrl: "https://shop.test",
  apiBaseUrl: "https://shop.test/wp-json/wc/v3",
  apiVersion: "wc/v3",
  consumerKey: "ck",
  consumerSecret: "cs",
};

function res(status: number, body: string, contentType = "application/json"): Response {
  const h = new Map([["content-type", contentType]]);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => h.get(k.toLowerCase()) ?? null },
    text: async () => body,
  } as unknown as Response;
}

describe("classifyWooHttpError / htmlLooking", () => {
  it("маппит статусы в понятные ошибки и флаг повторяемости", () => {
    expect(classifyWooHttpError(401, "").kind).toBe("auth");
    expect(classifyWooHttpError(401, "").retryable).toBe(false);
    expect(classifyWooHttpError(403, "").kind).toBe("forbidden");
    expect(classifyWooHttpError(404, "").kind).toBe("not_found");
    expect(classifyWooHttpError(429, "").retryable).toBe(true);
    expect(classifyWooHttpError(503, "").kind).toBe("server");
    expect(classifyWooHttpError(503, "").retryable).toBe(true);
  });

  it("детектит HTML вместо JSON", () => {
    expect(htmlLooking("text/html", "")).toBe(true);
    expect(htmlLooking("application/json", "<!DOCTYPE html><html>")).toBe(true);
    expect(htmlLooking("application/json", '{"ok":true}')).toBe(false);
  });
});

describe("wooRequest — retry-политика", () => {
  it("повторяет 5xx и добивается успеха", async () => {
    let n = 0;
    const fetchImpl = vi.fn(async () => {
      n++;
      return n < 3 ? res(503, "err") : res(200, JSON.stringify([{ id: 1 }]));
    });
    const out = await wooRequest<{ id: number }[]>(creds, "/products", {}, { fetchImpl, sleep: async () => {}, maxAttempts: 3 });
    expect(out.data).toEqual([{ id: 1 }]);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("НЕ повторяет 401 (бросает сразу)", async () => {
    const fetchImpl = vi.fn(async () => res(401, ""));
    await expect(wooRequest(creds, "/products", {}, { fetchImpl, sleep: async () => {}, maxAttempts: 3 })).rejects.toBeInstanceOf(WooApiError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("HTML-ответ → ошибка html (без повторов)", async () => {
    const fetchImpl = vi.fn(async () => res(200, "<!DOCTYPE html><html>blocked", "text/html"));
    await expect(wooRequest(creds, "/products", {}, { fetchImpl, sleep: async () => {}, maxAttempts: 3 })).rejects.toMatchObject({ kind: "html" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
