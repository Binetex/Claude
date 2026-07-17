import { describe, it, expect } from "vitest";
import { wooCommerceOrderAdapter, parseWooOrder, type WooOrder } from "./orderAdapter";
import { mapWooStatus } from "./statusMap";
import { assertOrderAdapterContract } from "@/integrations/contract/orderAdapter.contract";

const sampleWoo: WooOrder = {
  id: 812,
  number: "812",
  status: "processing",
  date_created: "2026-07-17T10:00:00",
  date_created_gmt: "2026-07-17T17:00:00",
  billing: { first_name: "Jane", last_name: "Doe", phone: "+1 555 111 2222", email: "jane@example.com" },
  shipping: { first_name: "John", last_name: "Roe", phone: "555-333-4444", address_1: "10 Rose St", address_2: "Apt 4", city: "Portland", postcode: "97201", country: "US" },
  line_items: [
    { id: 1, name: "Peony Bouquet", product_id: 55, variation_id: 91, sku: "PEO-L", quantity: 2, price: "49.00" },
    { id: 2, name: "Vase", product_id: 60, quantity: 1, price: "12.50" },
  ],
  total: "110.50",
  total_tax: "0",
  shipping_total: "0",
  discount_total: "0",
  customer_note: "Happy birthday!",
  meta_data: [{ key: "delivery_date", value: "2026-07-19" }, { key: "delivery_time", value: "14:00 – 18:00" }],
};

describe("WooCommerce OrderAdapter — нормализация заказа", () => {
  it("проходит общий контракт OrderAdapter", () => {
    assertOrderAdapterContract(wooCommerceOrderAdapter, sampleWoo);
  });

  it("маппит основные поля и позиции", () => {
    const o = parseWooOrder(sampleWoo);
    expect(o.platform).toBe("WOOCOMMERCE");
    expect(o.externalId).toBe("812");
    expect(o.items).toHaveLength(2);
    expect(o.items[0].variantExternalId).toBe("91");
    expect(o.recipient.name).toBe("John Roe");
    expect(o.shippingAddress?.line1).toBe("10 Rose St");
    expect(o.cardMessage).toBe("Happy birthday!");
    expect(o.deliveryDate).toBe("2026-07-19");
  });

  it("createdAt берётся из date_created_gmt с суффиксом Z (таймзона-корректно)", () => {
    const o = parseWooOrder(sampleWoo);
    expect(o.createdAt).toBe("2026-07-17T17:00:00Z");
    // Fallback на date_created, если gmt отсутствует.
    const noGmt = parseWooOrder({ ...sampleWoo, date_created_gmt: undefined });
    expect(noGmt.createdAt).toBe("2026-07-17T10:00:00");
  });

  it("извлекает суммы как числа", () => {
    const o = parseWooOrder(sampleWoo);
    expect(o.money.total).toBe(110.5);
    expect(o.money.itemsTotal).toBeCloseTo(110.5); // 49*2 + 12.5
  });
});

describe("mapWooStatus — маппинг статусов Woo → внутренние", () => {
  it("processing → оплачен + подтверждён", () => {
    expect(mapWooStatus("processing")).toEqual({ payment: "PAID", order: "CONFIRMED", delivery: null });
  });
  it("completed → доставлен", () => {
    expect(mapWooStatus("completed")).toEqual({ payment: "PAID", order: "DELIVERED", delivery: "DELIVERED" });
  });
  it("cancelled/failed → отменён", () => {
    expect(mapWooStatus("cancelled").order).toBe("CANCELLED");
    expect(mapWooStatus("failed").order).toBe("CANCELLED");
  });
  it("refunded → оплата REFUNDED, заказ CANCELLED (не возвращается в активную работу)", () => {
    expect(mapWooStatus("refunded")).toEqual({ payment: "REFUNDED", order: "CANCELLED", delivery: null });
  });
  it("неизвестный статус не роняет и даёт AWAITING_PAYMENT", () => {
    expect(mapWooStatus("some-custom-status").order).toBe("AWAITING_PAYMENT");
  });
});
