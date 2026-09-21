import { describe, it, expect } from "vitest";
import { initialsOf } from "./Avatar";

/**
 * Инициалы — единственное, что видно в шапке, пока сотрудник не загрузил фото, поэтому они
 * обязаны получаться у любого имени, которое реально встречается в базе.
 */
describe("инициалы в аватарке", () => {
  it("имя и фамилия дают две буквы, одно слово — одну", () => {
    expect(initialsOf("Иван Белфорд")).toBe("ИБ");
    expect(initialsOf("Настя")).toBe("Н");
    expect(initialsOf("Julie Flowers")).toBe("JF");
  });

  it("третье слово не берётся: три буквы в кружок 36 пикселей не влезают", () => {
    expect(initialsOf("Анна Мария Петрова")).toBe("АМ");
  });

  it("лишние пробелы не превращаются в пустые буквы", () => {
    expect(initialsOf("  Настя   Иванова  ")).toBe("НИ");
  });

  it("пустое имя не роняет шапку", () => {
    expect(initialsOf("")).toBe("?");
    expect(initialsOf("   ")).toBe("?");
  });

  it("эмодзи в имени берётся целиком, а не половиной суррогатной пары", () => {
    expect(initialsOf("🌸 Flowerbar")).toBe("🌸F");
  });
});
