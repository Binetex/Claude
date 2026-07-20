import { describe, it, expect } from "vitest";
import {
  extractShopifyOrderNumber,
  extractSenderAddress,
  formatSenderAddress,
  hasSenderAddress,
  normalizeDeliveryInstructions,
  pickDeliveryInstructionsFromFulfillmentOrders,
} from "./orderFields";

describe("extractShopifyOrderNumber (#1 — номер из name, а не order_number)", () => {
  it("name='#41308' → '41308' (не '1308' из order_number)", () => {
    expect(extractShopifyOrderNumber("#41308", 1308, "7073173995842")).toBe("41308");
  });
  it("несколько ведущих # и пробелы обрезаются", () => {
    expect(extractShopifyOrderNumber("  ##1058 ", 58, "x")).toBe("1058");
  });
  it("нет name → order_number", () => {
    expect(extractShopifyOrderNumber(null, 1308, "ext")).toBe("1308");
    expect(extractShopifyOrderNumber("  ", 1308, "ext")).toBe("1308");
  });
  it("нет name и order_number → externalId", () => {
    expect(extractShopifyOrderNumber(undefined, null, "7073173995842")).toBe("7073173995842");
  });
});

describe("extractSenderAddress (#3 — billing address отправителя)", () => {
  const billing = { address1: "3061 SW Fairmount Blvd", address2: null, city: "Portland", province_code: "OR", zip: "97239", country_code: "US" };
  it("маппит billing_address в поля отправителя", () => {
    expect(extractSenderAddress(billing)).toEqual({
      senderAddressLine: "3061 SW Fairmount Blvd",
      senderApartment: null,
      senderCity: "Portland",
      senderProvince: "OR",
      senderZip: "97239",
      senderCountry: "US",
    });
  });
  it("пустой/отсутствующий billing → все null; hasSenderAddress=false", () => {
    const a = extractSenderAddress(null);
    expect(a.senderAddressLine).toBeNull();
    expect(hasSenderAddress(a)).toBe(false);
  });
  it("province берётся из province_code, иначе province", () => {
    expect(extractSenderAddress({ province: "Oregon" }).senderProvince).toBe("Oregon");
  });
  it("formatSenderAddress — аккуратная строка", () => {
    expect(formatSenderAddress(extractSenderAddress(billing))).toBe("3061 SW Fairmount Blvd, Portland OR 97239, US");
    expect(formatSenderAddress(extractSenderAddress(null))).toBeNull();
  });
});

describe("delivery instructions (#2 — реальное поле fulfillmentOrders.deliveryMethod)", () => {
  it("извлекает instructions из формы ответа Shopify Local Delivery", () => {
    const edges = [
      { node: { deliveryMethod: { additionalInformation: { instructions: "THEY ARE HOME TOMORROW JULY 18TH IN THE AFTERNOON." } } } },
    ];
    expect(pickDeliveryInstructionsFromFulfillmentOrders(edges)).toBe("THEY ARE HOME TOMORROW JULY 18TH IN THE AFTERNOON.");
  });
  it("берёт первую непустую; пустые/отсутствующие пропускает", () => {
    const edges = [
      { node: { deliveryMethod: { additionalInformation: { instructions: "  " } } } },
      { node: { deliveryMethod: null } },
      { node: { deliveryMethod: { additionalInformation: { instructions: "Leave at door" } } } },
    ];
    expect(pickDeliveryInstructionsFromFulfillmentOrders(edges)).toBe("Leave at door");
  });
  it("нет инструкций → '' (не ошибка)", () => {
    expect(pickDeliveryInstructionsFromFulfillmentOrders([])).toBe("");
    expect(pickDeliveryInstructionsFromFulfillmentOrders(null)).toBe("");
    expect(normalizeDeliveryInstructions(null)).toBe("");
  });
});
