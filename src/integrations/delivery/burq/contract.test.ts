import { describe, it, expect } from "vitest";
import { buildBurqDraftRequest, type DraftOrderInput, type PickupInput } from "./request";
import { normalizeBurqOrder } from "./client";
import type { BurqRawOrderResponse } from "./types";
import { mapBurqStatus } from "./statusMap";

/**
 * CONTRACT-фикстура Burq Create Order V2. Форма ПОДТВЕРЖДЕНА по официальной документации
 * (createorderv2 / getorderv2 / deleteorder), но фактическое сетевое поведение (создаётся ли
 * `request` без вызова курьера, поддержка x-idempotency-key, дедуп повторного POST) проверяется
 * sandbox smoke-тестом. Реального API здесь нет.
 *
 * Подтверждено доками: POST /v2/orders, auth x-api-key, база https://api.burqup.com/v2
 * (sandbox = тот же host + тестовый ключ → test_mode=true). items/pickup/dropoff обязательны;
 * pickup/dropoff плоские; начальный статус — `request`; статус в latest_delivery.status.
 * НЕ подтверждено: x-idempotency-key (в доках нет) → sandbox-гейт.
 */
const order: DraftOrderInput = {
  recipientName: "Jessica Miller",
  recipientPhone: "+13105550198",
  addressLine: "1430 5th St",
  apartment: "Apt 14",
  city: "Santa Monica",
  recipientState: "CA",
  zip: "90401",
  dropoffAtIso: "2026-07-18T21:00:00.000Z",
  dropoffInstructions: "Leave at door",
};
const pickup: PickupInput = {
  locationName: "Main Studio",
  contactName: "Jane Florist",
  contactPhone: "+13105551111",
  addressLine: "200 Market St",
  apartmentOrSuite: "Suite 5",
  city: "Los Angeles",
  state: "CA",
  zip: "90013",
  courierInstructions: "Ring bell",
};

describe("Burq Create Order V2 — планируемый request JSON", () => {
  it("точный payload (выверено по фактическому sandbox: без address_details, с order-level dimensions)", () => {
    const req = buildBurqDraftRequest("order_1:a1", order, pickup, { length: 12, width: 8, height: 8, weight: 3, dimensionUnit: "in", weightUnit: "lb" });
    expect(req).toEqual({
      items: [{ name: "Floral delivery", quantity: 1 }],
      external_order_ref: "order_1:a1",
      order_value: 50000,
      length: 12,
      width: 8,
      height: 8,
      weight: 3,
      dimension_unit: "in",
      weight_unit: "lb",
      preferred_provider_settings: { require_dropoff_photo: true },
      pickup: {
        address: "200 Market St, Los Angeles, CA 90013",
        unit: "Suite 5",
        phone_number: "+13105551111",
        name: "Jane Florist",
        notes: "Ring bell",
      },
      dropoff: {
        address: "1430 5th St, Santa Monica, CA 90401",
        unit: "Apt 14",
        phone_number: "+13105550198",
        name: "Jessica Miller",
        notes: "Leave at door",
        at: "2026-07-18T21:00:00.000Z",
      },
    });
  });

  it("НЕ содержит неподтверждённых/устаревших полей и address_details", () => {
    const req = buildBurqDraftRequest("order_1:a1", order, pickup) as Record<string, unknown>;
    for (const bad of ["initiate", "draft", "status", "reference_id", "dropoff_at"]) expect(req).not.toHaveProperty(bad);
    expect(req.pickup).not.toHaveProperty("address_details");
    expect(req.dropoff).not.toHaveProperty("address_details");
  });
});

describe("Burq Order V2 — ответ (normalizeBurqOrder): статус в latest_delivery", () => {
  const raw: BurqRawOrderResponse = {
    id: "ord_live_123",
    external_order_ref: "order_1:a1",
    checkout_url: "https://dashboard.burqup.com/checkout/ord_live_123",
    order_token: "jwt.mock.token",
    test_mode: true,
    latest_delivery: { status: "request", tracking_url: null, courier: null },
  };

  it("нормализует id/checkout/order_token/test_mode и статус из latest_delivery", () => {
    const o = normalizeBurqOrder(raw);
    expect(o).toEqual({
      id: "ord_live_123",
      status: "request",
      checkoutUrl: "https://dashboard.burqup.com/checkout/ord_live_123",
      orderToken: "jwt.mock.token",
      trackingUrl: null,
      courierName: null,
      courierPhone: null,
      testMode: true,
      externalOrderRef: "order_1:a1",
      totalAmountDueCents: null,
      feeCents: null,
      currency: null,
      provider: null,
      providerId: null,
      quoteId: null,
      proofOfDeliveryUrls: [],
      signatureImageUrl: null,
    });
    expect(mapBurqStatus(o.status)).toBe("DRAFT_CREATED");
  });

  it("нормализует POD: proof_of_delivery_image_urls[] → массив, signature_image_url → строка", () => {
    const o = normalizeBurqOrder({
      id: "ord_pod",
      latest_delivery: { status: "delivered", proof_of_delivery_image_urls: ["https://pod/1.jpg", "https://pod/2.jpg"], signature_image_url: "https://pod/sig.png" },
    });
    expect(o.proofOfDeliveryUrls).toEqual(["https://pod/1.jpg", "https://pod/2.jpg"]);
    expect(o.signatureImageUrl).toBe("https://pod/sig.png");
  });

  it("courier.phone_number_for_customer → courierPhone; latest_delivery.status", () => {
    const o = normalizeBurqOrder({
      id: "ord2",
      latest_delivery: { status: "driver_assigned", tracking_url: "https://t/x", courier: { name: "Sam", phone_number_for_customer: "+13105550000" } },
    });
    expect(o.status).toBe("driver_assigned");
    expect(o.courierName).toBe("Sam");
    expect(o.courierPhone).toBe("+13105550000");
    expect(o.trackingUrl).toBe("https://t/x");
    expect(mapBurqStatus(o.status)).toBe("COURIER_ASSIGNED");
  });

  it("без latest_delivery → статус по умолчанию request", () => {
    expect(normalizeBurqOrder({ id: "ord3" }).status).toBe("request");
  });
});
