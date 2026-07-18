import { describe, it, expect } from "vitest";
import crypto from "crypto";
import { wooCommerceWebhookAdapter } from "./webhookAdapter";

const secret = "whsec_test";
const body = JSON.stringify({ id: 555, status: "processing" });
const validSig = crypto.createHmac("sha256", secret).update(body, "utf8").digest("base64");

describe("wooCommerceWebhookAdapter.verify (сценарии 17,19)", () => {
  it("17) корректная подпись → ok", () => {
    const r = wooCommerceWebhookAdapter.verify({ rawBody: body, headers: { "x-wc-webhook-signature": validSig }, secret });
    expect(r.ok).toBe(true);
  });

  it("19) неверная подпись → invalid_signature", () => {
    const r = wooCommerceWebhookAdapter.verify({ rawBody: body, headers: { "x-wc-webhook-signature": "AAAA" }, secret });
    expect(r).toEqual({ ok: false, reason: "invalid_signature" });
  });

  it("нет подписи / нет секрета → отклоняем", () => {
    expect(wooCommerceWebhookAdapter.verify({ rawBody: body, headers: {}, secret }).ok).toBe(false);
    expect(wooCommerceWebhookAdapter.verify({ rawBody: body, headers: { "x-wc-webhook-signature": validSig }, secret: null }).ok).toBe(false);
  });

  it("подмена тела ломает подпись (constant-time сравнение)", () => {
    const tampered = JSON.stringify({ id: 555, status: "completed" });
    expect(wooCommerceWebhookAdapter.verify({ rawBody: tampered, headers: { "x-wc-webhook-signature": validSig }, secret }).ok).toBe(false);
  });

  it("extractEventId берёт x-wc-webhook-id, иначе id из тела", () => {
    expect(wooCommerceWebhookAdapter.extractEventId({ rawBody: body, headers: { "x-wc-webhook-id": "77" }, secret })).toBe("77");
    expect(wooCommerceWebhookAdapter.extractEventId({ rawBody: body, headers: {}, secret })).toBe("555");
  });
});
