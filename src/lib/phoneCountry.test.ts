import { describe, it, expect } from "vitest";
import { withCountryCode } from "./phoneCountry";

// Номера — из упавших SMS заказчикам за сентябрь 2026: всем им приклеивалось «+1».
describe("withCountryCode — код страны из платёжного адреса", () => {
  it("местный номер иностранного заказчика получает код его страны", () => {
    expect(withCountryCode("8712647484", "MX")).toBe("+528712647484"); // THEFLOW-20861
    expect(withCountryCode("0503274701", "IL")).toBe("+972503274701");
    expect(withCountryCode("0431817498", "AU")).toBe("+61431817498");
    expect(withCountryCode("07971733925", "GB")).toBe("+447971733925");
    expect(withCountryCode("4151497988", "MX")).toBe("+524151497988"); // 415-149 в США не бывает
  });

  it("код страны, набранный без «+» или через 00, не удваивается", () => {
    expect(withCountryCode("52 8712647484", "MX")).toBe("+528712647484");
    expect(withCountryCode("0052 871 264 7484", "MX")).toBe("+528712647484");
  });

  it("США, пустая страна и номер с «+» — как было", () => {
    expect(withCountryCode("(310) 555-1234", "US")).toBe("(310) 555-1234");
    expect(withCountryCode("3105551234", null)).toBe("3105551234");
    expect(withCountryCode("+52 871 338 1659", "MX")).toBe("+52 871 338 1659");
    expect(withCountryCode("", "MX")).toBe("");
  });

  it("номер, который для этой страны не складывается, не выдумывается", () => {
    expect(withCountryCode("3105551234", "GB")).toBe("3105551234"); // американец с британским адресом
    expect(withCountryCode("12", "MX")).toBe("12");
  });
});
