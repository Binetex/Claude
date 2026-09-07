import { describe, it, expect } from "vitest";
import { secretTail, secretPlaceholder } from "./secretHint";

describe("secretTail", () => {
  it("показывает последние четыре знака сохранённого значения", () => {
    expect(secretTail("********6919")).toBe("••••6919");
  });

  it("значения нет — подсказывать нечего", () => {
    expect(secretTail(null)).toBeNull();
    expect(secretTail("")).toBeNull();
    // Короткий секрет маскируется одними звёздочками: хвоста в нём нет.
    expect(secretTail("********")).toBeNull();
  });
});

describe("secretPlaceholder", () => {
  it("пустое поле — только название", () => {
    expect(secretPlaceholder(null, "Bot Token")).toBe("Bot Token");
  });

  it("настроенное — название и хвост, без «пусто = не менять»", () => {
    expect(secretPlaceholder("********abcd", "API Key")).toBe("API Key · сейчас ••••abcd");
  });
});
