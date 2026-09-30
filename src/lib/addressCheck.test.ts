import { describe, it, expect } from "vitest";
import { deliveryAddressIssue, addressWarning } from "./addressCheck";

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
