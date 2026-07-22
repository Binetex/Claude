import { describe, it, expect } from "vitest";
import { isE164, isUsState, isUsZip, validatePickupLocation } from "./pickupValidation";

describe("isE164", () => {
  it("валидные", () => {
    expect(isE164("+13105550198")).toBe(true);
    expect(isE164("+441234567890")).toBe(true);
  });
  it("невалидные", () => {
    expect(isE164("3105550198")).toBe(false); // без +
    expect(isE164("+0123")).toBe(false); // начинается с 0 / слишком коротко
    expect(isE164("+1")).toBe(false);
    expect(isE164("")).toBe(false);
    expect(isE164(null)).toBe(false);
  });
});

describe("isUsState", () => {
  it("двухбуквенные коды, регистронезависимо", () => {
    expect(isUsState("CA")).toBe(true);
    expect(isUsState("ca")).toBe(true);
    expect(isUsState("DC")).toBe(true);
  });
  it("невалидные", () => {
    expect(isUsState("California")).toBe(false);
    expect(isUsState("ZZ")).toBe(false);
    expect(isUsState(null)).toBe(false);
  });
});

describe("isUsZip", () => {
  it("5 и ZIP+4", () => {
    expect(isUsZip("90401")).toBe(true);
    expect(isUsZip("90401-1234")).toBe(true);
  });
  it("невалидные", () => {
    expect(isUsZip("9040")).toBe(false);
    expect(isUsZip("abcde")).toBe(false);
  });
});

const VALID = {
  locationName: "Main Studio",
  contactName: "Jane",
  contactPhone: "+13105550198",
  addressLine: "1430 5th St",
  city: "Santa Monica",
  state: "CA",
  zip: "90401",
  isActive: true,
};

describe("validatePickupLocation", () => {
  it("полная валидная локация", () => {
    expect(validatePickupLocation(VALID)).toEqual({ valid: true, errors: [] });
  });
  it("отсутствие локации → pickup_missing", () => {
    expect(validatePickupLocation(null)).toEqual({ valid: false, errors: ["pickup_missing"] });
  });
  it("неактивная локация невалидна", () => {
    const r = validatePickupLocation({ ...VALID, isActive: false });
    expect(r.valid).toBe(false);
    expect(r.errors).toContain("pickup_inactive");
  });
  it("собирает несколько ошибок без PII", () => {
    const r = validatePickupLocation({ ...VALID, contactPhone: "123", state: "ZZ", zip: "x" });
    expect(r.valid).toBe(false);
    expect(r.errors).toEqual(expect.arrayContaining(["contact_phone_invalid", "state_invalid", "zip_invalid"]));
    // коды ошибок машинные, без адресов/телефонов
    expect(r.errors.join(",")).not.toMatch(/\d{3,}/);
  });
});
