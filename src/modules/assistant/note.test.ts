import { describe, it, expect } from "vitest";
import { prependReadyTimeNote, NOTE_SEPARATOR } from "./note";

/** Формат заметки — договорённость с владельцем: сверху, с датой, через разделитель. */
describe("заметка о времени готовности", () => {
  const at = new Date("2026-09-05T21:32:00.000Z"); // 14:32 в Лос-Анджелесе

  it("пустая заметка — одна строка с датой по времени магазина", () => {
    expect(prependReadyTimeNote("", "after 5pm", at, "America/Los_Angeles")).toBe("05.09, 14:32 · Клиент (SMS): готов принять after 5pm");
  });

  it("непустая — новая строка сверху, старое ниже разделителя", () => {
    const out = prependReadyTimeNote("Просит пораньше", "after 5pm", at, "America/Los_Angeles");
    const [first, sep, rest] = out.split("\n");
    expect(first).toContain("after 5pm");
    expect(sep).toBe(NOTE_SEPARATOR);
    expect(rest).toBe("Просит пораньше");
  });

  it("второй ответ клиента встаёт над первым", () => {
    const once = prependReadyTimeNote("", "after 5pm", at, null);
    const twice = prependReadyTimeNote(once, "tomorrow morning", at, null);
    expect(twice.indexOf("tomorrow morning")).toBeLessThan(twice.indexOf("after 5pm"));
  });
});
