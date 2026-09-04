import { describe, it, expect } from "vitest";
import { combineDropoffNotes } from "./dropoffNotes";

/**
 * Что именно уезжает курьеру.
 *
 * История: в Burq уходила `Order.customerNote` — внутренняя заметка команды. Из 11 заполненных
 * на проде заказов 10 были заведены руками («Просит пораньше», «Записку именно на 3 коробки»,
 * «Тест»), и всё это читал курьер. Теперь наружу идёт только `courierNote`, который для него
 * и написан, а стандартный текст магазина по-прежнему ДОПОЛНЯЕТСЯ, а не заменяется.
 */
const SITE_DEFAULT = "Please take a photo of the delivered flowers.";

describe("инструкция курьеру складывается со стандартным текстом магазина", () => {
  it("стандартный текст идёт первым, инструкция заказа следом", () => {
    const out = combineDropoffNotes(SITE_DEFAULT, "Gate code 3262");
    expect(out).toBe(`${SITE_DEFAULT}\nGate code 3262`);
  });

  it("пустая инструкция не отменяет стандартный текст", () => {
    expect(combineDropoffNotes(SITE_DEFAULT, "")).toBe(SITE_DEFAULT);
  });

  it("оба пустые — курьеру не отправляется ничего", () => {
    expect(combineDropoffNotes("", "   ")).toBeNull();
  });

  it("инструкция не заменяет стандартный текст собой", () => {
    // Замена значила бы, что просьба сфотографировать букет исчезает у каждого заказа,
    // где флорист дописал своё.
    const out = combineDropoffNotes(SITE_DEFAULT, "Ring the buzzer twice");
    expect(out).toContain(SITE_DEFAULT);
    expect(out).toContain("Ring the buzzer twice");
  });
});
