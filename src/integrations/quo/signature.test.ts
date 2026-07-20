import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import { verifyQuoSignature } from "./signature";

const KEY_B64 = Buffer.from("super-secret-signing-key-1234567").toString("base64");

function sign(rawBody: string, tsMs: number, keyB64 = KEY_B64): string {
  const sig = crypto.createHmac("sha256", Buffer.from(keyB64, "base64")).update(`${tsMs}.${rawBody}`).digest("base64");
  return `hmac;1;${tsMs};${sig}`;
}

describe("verifyQuoSignature", () => {
  const now = 1_700_000_000_000;
  const body = JSON.stringify({ id: "EV1", type: "message.received" });

  it("валидная подпись по raw body → valid", () => {
    const header = sign(body, now);
    expect(verifyQuoSignature(body, header, KEY_B64, { nowMs: now })).toEqual({ valid: true });
  });

  it("подделка тела → signature_mismatch", () => {
    const header = sign(body, now);
    expect(verifyQuoSignature(body + " ", header, KEY_B64, { nowMs: now })).toEqual({ valid: false, reason: "signature_mismatch" });
  });

  it("неверный ключ → mismatch", () => {
    const header = sign(body, now);
    const other = Buffer.from("another-key-000000000000000000000").toString("base64");
    expect(verifyQuoSignature(body, header, other, { nowMs: now }).valid).toBe(false);
  });

  it("слишком старый timestamp → replay-защита (timestamp_out_of_tolerance)", () => {
    const oldTs = now - 10 * 60 * 1000; // 10 минут назад, tolerance 5 мин
    const header = sign(body, oldTs);
    expect(verifyQuoSignature(body, header, KEY_B64, { nowMs: now })).toEqual({ valid: false, reason: "timestamp_out_of_tolerance" });
  });

  it("timestamp из будущего сверх допуска → отклонён", () => {
    const futureTs = now + 10 * 60 * 1000;
    const header = sign(body, futureTs);
    expect(verifyQuoSignature(body, header, KEY_B64, { nowMs: now }).reason).toBe("timestamp_out_of_tolerance");
  });

  it("нет заголовка / ключа / кривой формат", () => {
    expect(verifyQuoSignature(body, null, KEY_B64, { nowMs: now })).toEqual({ valid: false, reason: "missing_signature" });
    expect(verifyQuoSignature(body, sign(body, now), null, { nowMs: now })).toEqual({ valid: false, reason: "missing_signing_key" });
    expect(verifyQuoSignature(body, "garbage", KEY_B64, { nowMs: now })).toEqual({ valid: false, reason: "malformed_header" });
    expect(verifyQuoSignature(body, `sha1;1;${now};xxx`, KEY_B64, { nowMs: now })).toEqual({ valid: false, reason: "unsupported_scheme" });
  });
});
