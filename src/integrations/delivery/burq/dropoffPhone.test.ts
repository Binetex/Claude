import { describe, it, expect } from "vitest";
import { resolveDropoffPhone, DEFAULT_DROPOFF_PHONE } from "./dropoffPhone";

/**
 * Единственное жёсткое требование: результат НИКОГДА не пустой. Пустой телефон Burq отвергает с
 * 400, черновик умирает в dead-letter после восьми попыток, и заказ остаётся без доставки молча —
 * так потерялись THEFLOW-20315 и -20429.
 */
describe("телефон для dropoff", () => {
  it("берёт телефон получателя, когда он есть", () => {
    expect(resolveDropoffPhone({ recipientPhone: "+13105551234", senderPhone: "+1999", storePhone: "+1888" })).toBe("+13105551234");
  });

  it("пустой телефон получателя → телефон заказчика", () => {
    expect(resolveDropoffPhone({ recipientPhone: "", senderPhone: "+13109998877", storePhone: "+1888" })).toBe("+13109998877");
  });

  it("нет ни того ни другого → номер магазина", () => {
    expect(resolveDropoffPhone({ recipientPhone: "", senderPhone: null, storePhone: "+13235550000" })).toBe("+13235550000");
  });

  it("нет вообще ничего → общий запасной номер", () => {
    expect(resolveDropoffPhone({ recipientPhone: null, senderPhone: null, storePhone: null })).toBe(DEFAULT_DROPOFF_PHONE);
  });

  it("строка без единой цифры телефоном не считается", () => {
    // В заказах встречаются «—», «нет», пробелы. Такое Burq отвергнет так же, как пустоту.
    for (const junk of ["—", "нет", "   ", "-"]) {
      expect(resolveDropoffPhone({ recipientPhone: junk, senderPhone: "+13105551234", storePhone: null })).toBe("+13105551234");
    }
  });

  it("обрезает пробелы по краям", () => {
    expect(resolveDropoffPhone({ recipientPhone: "  +13105551234 ", senderPhone: null, storePhone: null })).toBe("+13105551234");
  });

  it("результат непустой при любом входе", () => {
    const inputs = [null, undefined, "", "   ", "—"];
    for (const r of inputs) {
      for (const s of inputs) {
        for (const st of inputs) {
          expect(resolveDropoffPhone({ recipientPhone: r, senderPhone: s, storePhone: st })).not.toBe("");
        }
      }
    }
  });
});
