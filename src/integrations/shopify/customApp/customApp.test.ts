import { describe, it, expect } from "vitest";
import crypto from "crypto";
import { parseMyshopifyDomain, normalizeMyshopifyDomain, isMyshopifyDomain } from "./domain";
import { diffScopes, REQUIRED_SHOPIFY_SCOPES, requiredScopesText } from "./scopes";
import { deriveConnectionResult } from "./connectionLogic";
import {
  secretsForVerification,
  verifyWebhookHmac,
  computeWebhookHmac,
  isStaleUpdate,
  isForbiddenStatusTransition,
} from "./webhookVerifyLogic";

describe("domain — строгая валидация *.myshopify.com", () => {
  it("принимает канонический домен", () => {
    expect(parseMyshopifyDomain("my-store.myshopify.com")).toEqual({ ok: true, domain: "my-store.myshopify.com" });
  });
  it("нормализует протокол/путь/регистр", () => {
    expect(normalizeMyshopifyDomain("HTTPS://My-Store.myshopify.com/admin")).toBe("my-store.myshopify.com");
    expect(parseMyshopifyDomain(" https://Shop123.myshopify.com/ ").ok).toBe(true);
  });
  it("отклоняет storefront/произвольные домены", () => {
    for (const bad of ["store.com", "shop.domain.com", "https://mystore.com", "myshop.myshopify.io", "not a domain"]) {
      expect(parseMyshopifyDomain(bad).ok).toBe(false);
    }
  });
  it("isMyshopifyDomain", () => {
    expect(isMyshopifyDomain("a.myshopify.com")).toBe(true);
    expect(isMyshopifyDomain("a.com")).toBe(false);
  });
});

describe("scopes — обязательные и diff", () => {
  it("required = read_products, read_orders, write_orders", () => {
    expect([...REQUIRED_SHOPIFY_SCOPES]).toEqual(["read_products", "read_orders", "write_orders"]);
    expect(requiredScopesText()).toBe("read_products,read_orders,write_orders");
  });
  it("hasAll когда все выданы", () => {
    expect(diffScopes(["read_products", "read_orders", "write_orders", "read_content"]).hasAll).toBe(true);
  });
  it("missing когда часть отсутствует", () => {
    const d = diffScopes(["read_products"]);
    expect(d.hasAll).toBe(false);
    expect(d.missing).toEqual(["read_orders", "write_orders"]);
  });
});

describe("connectionLogic — вывод статуса", () => {
  const shop = { name: "Demo Flowers", myshopifyDomain: "demo.myshopify.com" };
  it("совпадение домена + все scopes → CONNECTED", () => {
    const r = deriveConnectionResult({ enteredDomain: "demo.myshopify.com", shop, grantedScopes: ["read_products", "read_orders", "write_orders"] });
    expect(r.status).toBe("CONNECTED");
    expect(r.ok).toBe(true);
    expect(r.canSyncProducts && r.canSyncOrders).toBe(true);
  });
  it("совпадение домена + часть scopes → DEGRADED", () => {
    const r = deriveConnectionResult({ enteredDomain: "demo.myshopify.com", shop, grantedScopes: ["read_orders", "write_orders"] });
    expect(r.status).toBe("DEGRADED");
    expect(r.missingScopes).toEqual(["read_products"]);
    expect(r.canSyncProducts).toBe(false);
    expect(r.canSyncOrders).toBe(true);
  });
  it("НЕсовпадение домена → REAUTH_REQUIRED, не активируем", () => {
    const r = deriveConnectionResult({ enteredDomain: "flowerbar.myshopify.com", shop, grantedScopes: ["read_products", "read_orders", "write_orders"] });
    expect(r.status).toBe("REAUTH_REQUIRED");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/другому магазину/);
  });
});

describe("webhookVerifyLogic — multi-store HMAC + ротация", () => {
  const rawBody = JSON.stringify({ id: 123, order_number: 1 });
  const current = "current_client_secret";
  const previous = "previous_client_secret";
  const sig = (secret: string) => computeWebhookHmac(rawBody, secret);

  it("проверяет текущим секретом", () => {
    const secrets = secretsForVerification({ currentSecret: current });
    expect(verifyWebhookHmac(rawBody, sig(current), secrets)).toBe(true);
    expect(verifyWebhookHmac(rawBody, sig("wrong"), secrets)).toBe(false);
  });

  it("окно ротации: previous валиден до previousValidUntil", () => {
    const now = new Date("2026-07-18T00:00:00Z");
    const within = secretsForVerification({ currentSecret: current, previousSecret: previous, previousValidUntil: new Date(now.getTime() + 3600_000), now });
    expect(verifyWebhookHmac(rawBody, sig(previous), within)).toBe(true); // старая подпись ещё принимается

    const expired = secretsForVerification({ currentSecret: current, previousSecret: previous, previousValidUntil: new Date(now.getTime() - 1000), now });
    expect(verifyWebhookHmac(rawBody, sig(previous), expired)).toBe(false); // окно истекло
    expect(verifyWebhookHmac(rawBody, sig(current), expired)).toBe(true);
  });

  it("подделанное тело не проходит (тот же secret, другой body)", () => {
    const secrets = secretsForVerification({ currentSecret: current });
    const tampered = rawBody.replace("123", "999");
    expect(verifyWebhookHmac(tampered, sig(current), secrets)).toBe(false);
  });

  it("нет заголовка/секретов → false", () => {
    expect(verifyWebhookHmac(rawBody, null, [current])).toBe(false);
    expect(verifyWebhookHmac(rawBody, sig(current), [])).toBe(false);
  });

  it("constant-time сравнение эквивалентно верному значению", () => {
    const expected = crypto.createHmac("sha256", current).update(rawBody).digest("base64");
    expect(verifyWebhookHmac(rawBody, expected, [current])).toBe(true);
  });
});

describe("webhookVerifyLogic — out-of-order и запрет откатов", () => {
  it("устаревшее событие определяется по updated_at", () => {
    expect(isStaleUpdate(new Date("2026-07-18T10:00:00Z"), new Date("2026-07-18T12:00:00Z"))).toBe(true);
    expect(isStaleUpdate(new Date("2026-07-18T13:00:00Z"), new Date("2026-07-18T12:00:00Z"))).toBe(false);
    expect(isStaleUpdate(null, new Date())).toBe(false);
  });
  it("запрещает откаты CANCELLED/DELIVERED/REFUNDED → назад", () => {
    expect(isForbiddenStatusTransition("CANCELLED", "CONFIRMED")).toBe(true);
    expect(isForbiddenStatusTransition("DELIVERED", "CONFIRMED")).toBe(true);
    expect(isForbiddenStatusTransition("REFUNDED", "IN_PROGRESS")).toBe(true);
    expect(isForbiddenStatusTransition("CONFIRMED", "IN_PROGRESS")).toBe(false); // нормальный вперёд
  });
});
