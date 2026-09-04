import { describe, it, expect } from "vitest";
import { looksLikeShopping } from "./catalog";

/**
 * Когда каталог едет в запрос. Ошибка в обе стороны стоит денег и качества: без каталога
 * «посоветуйте гортензии» остаётся без ответа, с каталогом на каждый «во сколько привезут»
 * запрос раздувается вчетверо.
 */
describe("похоже ли на разговор о покупке", () => {
  it("да — просьба посоветовать, названия цветов, поводы", () => {
    for (const t of [
      "can you recommend something for a birthday",
      "do you have white hydrangeas?",
      "looking for peonies under $200",
      "how much is a rose bouquet",
      "I want to order flowers for a funeral",
    ]) {
      expect(looksLikeShopping(t)).toBe(true);
    }
  });

  it("нет — вопросы про уже сделанный заказ", () => {
    for (const t of ["where is my order?", "what time will it arrive", "nobody is home, can you come later", "did you deliver it"]) {
      expect(looksLikeShopping(t)).toBe(false);
    }
  });
});
