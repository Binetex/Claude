import { describe, it, expect } from "vitest";
import { hintKind } from "./link";

/** Подсказка «какой заказ»: номер ищем по цифрам, всё остальное — по имени и адресу. */
describe("что назвал клиент", () => {
  it("номер заказа", () => {
    expect(hintKind("20654")).toBe("number");
    expect(hintKind("THEFLOW-20654")).toBe("number");
    expect(hintKind("#1234")).toBe("number");
  });

  it("имя или адрес", () => {
    expect(hintKind("Maria Lopez")).toBe("text");
    expect(hintKind("123 Main St, Apt 4")).toBe("text"); // цифры есть, но это адрес
    expect(hintKind("12632 Matteson Ave Los Angeles")).toBe("text");
  });
});
