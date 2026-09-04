import { describe, it, expect } from "vitest";
import { isConfirmation, isDiscard } from "./telegramReply";

/**
 * Что считается «отправляй как есть». Ошибка в обе стороны видна сразу: приняли за подтверждение
 * настоящий ответ — клиенту ушёл не тот текст; не приняли — владелец жмёт и ничего не происходит.
 */
describe("подтверждение отправки", () => {
  it("короткие согласия", () => {
    for (const t of ["+", "ок", "Ок", "ok", "OK.", "да", "yes", "отправь", "go", "👍"]) {
      expect(isConfirmation(t)).toBe(true);
    }
  });

  it("собственный ответ подтверждением не считается", () => {
    for (const t of [
      "напиши что доставим после 5",
      "ok but tell her we will be late",
      "да, но добавь что курьер позвонит",
      "send it tomorrow instead",
    ]) {
      expect(isConfirmation(t)).toBe(false);
    }
  });

  it("«-», «нет», «не надо» — не отвечать; остальное — свой текст", () => {
    for (const w of ["-", "нет", "No", "не надо", "cancel", "❌"]) expect(isDiscard(w)).toBe(true);
    for (const w of ["+", "ok", "we deliver at 2pm", "нет, привезём в 5"]) expect(isDiscard(w)).toBe(false);
  });
});
