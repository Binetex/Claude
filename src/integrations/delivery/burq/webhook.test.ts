import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import { verifyBurqSignature, parseBurqWebhook } from "./webhook";

const SECRET = "whsec_test_123";

function sign(rawBody: string, tSec: number, secret = SECRET): string {
  const v1 = crypto.createHmac("sha256", secret).update(`${tSec}.${rawBody}`).digest("hex");
  return `t=${tSec},v1=${v1}`;
}

describe("verifyBurqSignature", () => {
  const body = JSON.stringify({ id: "ord_1", status: "delivered" });
  const now = 1_800_000_000_000; // фиксированное «сейчас» (мс)
  const tSec = Math.floor(now / 1000);

  it("валидная подпись в пределах допуска", () => {
    const header = sign(body, tSec);
    expect(verifyBurqSignature(body, header, SECRET, 300, now)).toEqual({ valid: true });
  });

  it("подделанное тело → mismatch", () => {
    const header = sign(body, tSec);
    const r = verifyBurqSignature(body + "x", header, SECRET, 300, now);
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("signature_mismatch");
  });

  it("чужой секрет → mismatch", () => {
    const header = sign(body, tSec, "wrong");
    expect(verifyBurqSignature(body, header, SECRET, 300, now).valid).toBe(false);
  });

  it("устаревший timestamp вне окна → out_of_tolerance (replay)", () => {
    const oldTs = tSec - 10_000;
    const header = sign(body, oldTs);
    const r = verifyBurqSignature(body, header, SECRET, 300, now);
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("timestamp_out_of_tolerance");
  });

  it("отсутствующий заголовок/секрет", () => {
    expect(verifyBurqSignature(body, null, SECRET, 300, now).reason).toBe("missing_signature");
    expect(verifyBurqSignature(body, sign(body, tSec), "", 300, now).reason).toBe("missing_secret");
  });

  it("битый заголовок", () => {
    expect(verifyBurqSignature(body, "garbage", SECRET, 300, now).reason).toBe("malformed_header");
  });
});

describe("parseBurqWebhook — envelope {object:'event', type, data: Delivery}", () => {
  it("извлекает delivery id, НАШ external_order_ref, статус, курьера, tracking, стоимость/провайдера", () => {
    const ev = parseBurqWebhook({
      object: "event",
      type: "delivery.updated",
      data: {
        id: "d_01kxx", // delivery id
        external_order_ref: "order_1:a1", // НАШ ref — по нему матчим Delivery
        status: "enroute_pickup",
        updated_at: "2026-07-18T21:05:00.000Z",
        // РЕАЛЬНАЯ форма из PAR-1308: provider — ОБЪЕКТ {id: dsp_..., name}; provider_id — покоштучный del_.
        provider: { id: "dsp_19g67ldj7ek3j", name: "Uber" },
        provider_id: "del_abc",
        total_amount_due: null, // на enroute_pickup total ещё null → fallback на fee
        fee: 1449,
        currency: "USD",
        quote_id: "qo_1",
        tracking_url: "https://t/x",
        courier: { name: "Sam", phone_number_for_customer: "+1310" },
      },
    });
    expect(ev).toEqual({
      deliveryExternalId: "d_01kxx",
      externalOrderRef: "order_1:a1",
      rawStatus: "enroute_pickup",
      providerEventId: null,
      occurredAt: new Date("2026-07-18T21:05:00.000Z"),
      courierName: "Sam",
      courierPhone: "+1310",
      trackingUrl: "https://t/x",
      provider: "Uber", // извлечено из provider.name
      providerId: "dsp_19g67ldj7ek3j", // стабильный provider.id (НЕ покоштучный del_abc)
      totalAmountDueCents: null,
      feeCents: 1449,
      currency: "USD",
      quoteId: "qo_1",
    });
  });

  it("provider как строка (форма GET) → provider=строка, providerId=null", () => {
    const ev = parseBurqWebhook({ type: "delivery.updated", data: { id: "d_1", external_order_ref: "o:a1", status: "delivered", provider: "Uber", provider_id: "del_x" } });
    expect(ev?.provider).toBe("Uber");
    expect(ev?.providerId).toBeNull(); // строковая форма без стабильного dsp_
  });

  it("матчинг возможен даже если delivery id отсутствует, но есть external_order_ref", () => {
    const ev = parseBurqWebhook({ type: "delivery.updated", data: { external_order_ref: "o:a1", status: "delivered" } });
    expect(ev?.externalOrderRef).toBe("o:a1");
    expect(ev?.rawStatus).toBe("delivered");
  });

  it("без (id и external_order_ref) или без status → null", () => {
    expect(parseBurqWebhook({ data: { status: "delivered" } })).toBeNull();
    expect(parseBurqWebhook({ data: { id: "d_1" } })).toBeNull();
    expect(parseBurqWebhook({})).toBeNull();
  });
});
