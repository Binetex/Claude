import { describe, it, expect } from "vitest";
import { deliveryAddressIssue, addressWarning, hasUnit } from "./addressCheck";

describe("адрес доставки для курьера", () => {
  it("улица без номера дома — плохо, даже если номер ушёл во вторую строку (случаи с прода)", () => {
    expect(deliveryAddressIssue("Steddom Drive")).toBe("no_house_number"); // THEFLOW-20867
    expect(deliveryAddressIssue("Redwood Avenue")).toBe("no_house_number"); // номер «4338» был в квартире
    expect(deliveryAddressIssue("Ocean Front Walk")).toBe("no_house_number");
  });

  it("обычный адрес с номером — годится", () => {
    expect(deliveryAddressIssue("1250 N Kings Rd")).toBeNull();
    expect(deliveryAddressIssue("3715 South Canfield Avenue")).toBeNull();
  });

  it("пустой адрес — отдельный случай: карточка и так пишет «не указан»", () => {
    expect(deliveryAddressIssue("  ")).toBe("empty");
    expect(deliveryAddressIssue(null)).toBe("empty");
    expect(addressWarning("")).toBeNull();
    expect(addressWarning("Steddom Drive")).toContain("Нет номера дома");
  });
});

describe("квартира во второй строке адреса — а не район (THEFLOW-21254)", () => {
  it("район из автоподстановки чекаута TheFlow — не квартира", () => {
    for (const v of ["Central LA", "Mar Vista", "Venice", "Downtown Los Angeles", "Boca Pointe", "Frnt", "The Roxy", "", null]) {
      expect(hasUnit(v)).toBe(false);
    }
  });

  it("номер или слово юнита — квартира (значения с прода)", () => {
    for (const v of ["Central LA apt 7", "Central LA 1a", "Koreatown apt 308", "Unit 5", "Unit B", "Ste #402", "Suite 1000", "Room 802", "ph 7", "apt 208", "University Gateway Apartments - UGW- 842"]) {
      expect(hasUnit(v)).toBe(true);
    }
  });
});
