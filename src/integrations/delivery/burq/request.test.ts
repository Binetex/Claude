import { describe, it, expect } from "vitest";
import { buildBurqDraftRequest, type DraftOrderInput, type PickupInput } from "./request";

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

describe("buildBurqDraftRequest — контракт Create Order V2", () => {
  it("items/pickup/dropoff обязательны; external_order_ref вместо reference_id", () => {
    const req = buildBurqDraftRequest("order_1:a1", order, pickup);
    expect(req.items.length).toBeGreaterThanOrEqual(1);
    expect(req.external_order_ref).toBe("order_1:a1");
    expect(req).not.toHaveProperty("initiate");
    expect(req).not.toHaveProperty("reference_id");
    expect(req).not.toHaveProperty("dropoff_at");
  });

  it("нет items у заказа → одна обобщённая позиция", () => {
    const req = buildBurqDraftRequest("o:a1", order, pickup);
    expect(req.items).toEqual([{ name: "Floral delivery", quantity: 1 }]);
  });

  it("order_value всегда 50000 центов ($500), не из стоимости заказа Floremart", () => {
    const req = buildBurqDraftRequest("o:a1", order, pickup);
    expect(req.order_value).toBe(50000);
    // даже если у заказа задан свой orderValueCents — игнорируем
    const req2 = buildBurqDraftRequest("o:a1", { ...order, orderValueCents: 99999 }, pickup);
    expect(req2.order_value).toBe(50000);
  });

  it("pickup — плоский, из локации флориста; address без unit; notes; БЕЗ address_details", () => {
    const req = buildBurqDraftRequest("o:a1", order, pickup);
    expect(req.pickup.name).toBe("Jane Florist");
    expect(req.pickup.phone_number).toBe("+13105551111");
    expect(req.pickup.address).toBe("200 Market St, Los Angeles, CA 90013");
    expect(req.pickup.unit).toBe("Suite 5");
    expect(req.pickup.notes).toBe("Ring bell");
    expect(req.pickup).not.toHaveProperty("address_details");
  });

  it("dropoff — из получателя; at = желаемое время; address без unit; без address_details", () => {
    const req = buildBurqDraftRequest("o:a1", order, pickup);
    expect(req.dropoff.name).toBe("Jessica Miller");
    expect(req.dropoff.phone_number).toBe("+13105550198");
    expect(req.dropoff.address).toBe("1430 5th St, Santa Monica, CA 90401");
    expect(req.dropoff.unit).toBe("Apt 14");
    expect(req.dropoff.notes).toBe("Leave at door");
    expect(req.dropoff.at).toBe("2026-07-18T21:00:00.000Z");
    expect(req.dropoff).not.toHaveProperty("address_details");
  });

  it("запрашивает фото при dropoff: preferred_provider_settings.require_dropoff_photo=true (без signature)", () => {
    const req = buildBurqDraftRequest("o:a1", order, pickup);
    expect(req.preferred_provider_settings).toEqual({ require_dropoff_photo: true });
    expect(req).not.toHaveProperty("required_provider_settings");
    expect(JSON.stringify(req)).not.toContain("signature");
  });

  it("order-level dimensions обязательны (дефолт при отсутствии настройки)", () => {
    const req = buildBurqDraftRequest("o:a1", order, pickup);
    expect({ l: req.length, w: req.width, h: req.height, wt: req.weight, du: req.dimension_unit, wu: req.weight_unit }).toEqual({
      l: 12, w: 8, h: 8, wt: 3, du: "in", wu: "lb",
    });
  });

  it("dimensions из настроек прокидываются", () => {
    const req = buildBurqDraftRequest("o:a1", order, pickup, { length: 20, width: 10, height: 10, weight: 5, dimensionUnit: "cm", weightUnit: "kg" });
    expect(req.length).toBe(20);
    expect(req.dimension_unit).toBe("cm");
    expect(req.weight_unit).toBe("kg");
  });

  it("пустые опциональные поля не попадают", () => {
    const req = buildBurqDraftRequest("o:a1", { ...order, apartment: null, dropoffInstructions: "  ", dropoffAtIso: null }, { ...pickup, apartmentOrSuite: null, courierInstructions: "" });
    expect(req.dropoff.unit).toBeUndefined();
    expect(req.dropoff.notes).toBeUndefined();
    expect(req.dropoff.at).toBeUndefined();
    expect(req.pickup.unit).toBeUndefined();
    expect(req.pickup.notes).toBeUndefined();
  });

  it("передаёт items заказа, если заданы (order_value всегда 50000)", () => {
    const req = buildBurqDraftRequest("o:a1", { ...order, items: [{ name: "Roses", quantity: 2, unit_price: 5000 }] }, pickup);
    expect(req.items).toEqual([{ name: "Roses", quantity: 2, unit_price: 5000 }]);
    expect(req.order_value).toBe(50000);
  });

  it("объединённый dropoff-текст → dropoff.notes; pickup.notes = courierInstructions и НЕ зависит от dropoff", () => {
    const a = buildBurqDraftRequest("o:a1", { ...order, dropoffInstructions: "AAA" }, pickup);
    const b = buildBurqDraftRequest("o:a1", { ...order, dropoffInstructions: "SITE default\nGate 4521" }, pickup);
    expect(a.dropoff.notes).toBe("AAA");
    expect(b.dropoff.notes).toBe("SITE default\nGate 4521"); // объединённый текст проходит как есть
    expect(a.pickup.notes).toBe("Ring bell");
    expect(b.pickup.notes).toBe("Ring bell"); // pickup не меняется при разных dropoff-инструкциях
  });
});
