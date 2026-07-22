import { describe, it, expect } from "vitest";
import crypto from "crypto";
import { verifyHmacBase64 } from "./webhookVerify";
import { shopifyWebhookAdapter } from "./shopify/webhookAdapter";
import { wooCommerceWebhookAdapter } from "./woocommerce/webhookAdapter";
import type { WebhookInput } from "./types";

const SECRET = "test_app_secret";
const body = JSON.stringify({ id: 4501, order_number: 1053 });
const validSig = crypto.createHmac("sha256", SECRET).update(body, "utf8").digest("base64");

describe("verifyHmacBase64 — базовая проверка подписи", () => {
  it("принимает корректную подпись", () => {
    expect(verifyHmacBase64(body, validSig, SECRET)).toBe(true);
  });
  it("отклоняет подделанное тело (replay/tamper)", () => {
    const tampered = body.replace("1053", "9999");
    expect(verifyHmacBase64(tampered, validSig, SECRET)).toBe(false);
  });
  it("отклоняет неверный секрет", () => {
    expect(verifyHmacBase64(body, validSig, "wrong")).toBe(false);
  });
  it("отклоняет отсутствующую подпись/секрет", () => {
    expect(verifyHmacBase64(body, null, SECRET)).toBe(false);
    expect(verifyHmacBase64(body, validSig, null)).toBe(false);
  });
});

describe("shopifyWebhookAdapter.verify", () => {
  const input = (over: Partial<WebhookInput> = {}): WebhookInput => ({
    rawBody: body,
    headers: { "x-shopify-hmac-sha256": validSig, "x-shopify-webhook-id": "evt_1" },
    secret: SECRET,
    ...over,
  });

  it("ok при валидной подписи", () => {
    expect(shopifyWebhookAdapter.verify(input())).toEqual({ ok: true });
  });
  it("missing_signature без заголовка", () => {
    expect(shopifyWebhookAdapter.verify(input({ headers: {} }))).toEqual({ ok: false, reason: "missing_signature" });
  });
  it("no_secret без секрета", () => {
    expect(shopifyWebhookAdapter.verify(input({ secret: null }))).toEqual({ ok: false, reason: "no_secret" });
  });
  it("invalid_signature при подделке тела", () => {
    expect(shopifyWebhookAdapter.verify(input({ rawBody: body + " " }))).toEqual({ ok: false, reason: "invalid_signature" });
  });
  it("extractEventId берёт стабильный id для дедупликации", () => {
    expect(shopifyWebhookAdapter.extractEventId(input())).toBe("evt_1");
    expect(shopifyWebhookAdapter.extractEventId(input({ headers: { "x-shopify-hmac-sha256": validSig } }))).toBe("4501");
  });
});

describe("wooCommerceWebhookAdapter.verify", () => {
  const wooSig = crypto.createHmac("sha256", SECRET).update(body, "utf8").digest("base64");
  const input: WebhookInput = {
    rawBody: body,
    headers: { "x-wc-webhook-signature": wooSig, "x-wc-webhook-id": "77" },
    secret: SECRET,
  };
  it("ok при валидной подписи", () => {
    expect(wooCommerceWebhookAdapter.verify(input)).toEqual({ ok: true });
  });
  it("extractEventId из заголовка Woo", () => {
    expect(wooCommerceWebhookAdapter.extractEventId(input)).toBe("77");
  });
});
