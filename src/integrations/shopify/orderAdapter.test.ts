import { describe, it, expect } from "vitest";
import { shopifyOrderAdapter, parseShopifyOrder } from "./orderAdapter";
import type { ShopifyOrder } from "./ingestOrder";
import { assertOrderAdapterContract } from "@/integrations/contract/orderAdapter.contract";

const sample: ShopifyOrder = {
  id: 4501,
  order_number: 1053,
  email: "buyer@example.com",
  note: "С днём рождения!",
  note_attributes: [
    { name: "Delivery Date", value: "2026-07-19" },
    { name: "Delivery Time", value: "14:00 – 18:00" },
  ],
  financial_status: "paid",
  fulfillment_status: null,
  created_at: "2026-07-17T09:00:00-07:00",
  customer: { first_name: "Anna", last_name: "Buyer", phone: "555-1" },
  billing_address: { name: "Anna Buyer", phone: "555-1" },
  shipping_address: { name: "Recipient Name", phone: "555-2", address1: "5 Tulip Ave", city: "Salem", zip: "97301" },
  line_items: [
    { title: "White Roses", variant_title: "Medium", sku: "WR-M", quantity: 1, price: "89.00", product_id: 7, variant_id: 21 },
    { title: "Card", variant_title: "Default Title", quantity: 1, price: "0.00" },
  ],
  subtotal_price: "89.00",
  total_price: "97.30",
  total_tax: "8.30",
  total_tip_received: "0",
  total_discounts: "0",
};

describe("Shopify OrderAdapter — нормализация заказа", () => {
  it("проходит общий контракт OrderAdapter", () => {
    assertOrderAdapterContract(shopifyOrderAdapter, sample);
  });

  it("маппит статусы согласованно с ingest (paid → CONFIRMED)", () => {
    const o = parseShopifyOrder(sample);
    expect(o.status).toEqual({ payment: "PAID", order: "CONFIRMED", delivery: null });
  });

  it("fulfilled → DELIVERED, cancelled → CANCELLED", () => {
    expect(parseShopifyOrder({ ...sample, fulfillment_status: "fulfilled" }).status.order).toBe("DELIVERED");
    expect(parseShopifyOrder({ ...sample, cancelled_at: "2026-07-17T12:00:00Z" }).status.order).toBe("CANCELLED");
  });

  it("нормализует 'Default Title' в null и извлекает открытку/дату", () => {
    const o = parseShopifyOrder(sample);
    expect(o.items[1].variantName).toBeNull();
    expect(o.cardMessage).toBe("С днём рождения!");
    expect(o.deliveryDate).toBe("2026-07-19");
    expect(o.externalNumber).toBe("1053");
  });
});
