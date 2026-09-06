import { describe, it, expect } from "vitest";
import { isGlobalNoteActive, activeGlobalNoteText } from "./globalNote";

const day = (d: string) => new Date(`${d}T00:00:00.000Z`);

describe("общее правило ассистента", () => {
  it("без текста не действует, что бы ни стояло в сроке", () => {
    expect(isGlobalNoteActive(null, "2026-09-07")).toBe(false);
    expect(isGlobalNoteActive({ text: null, activeUntil: day("2026-12-31"), updatedAt: null }, "2026-09-07")).toBe(false);
    expect(isGlobalNoteActive({ text: "   ", activeUntil: null, updatedAt: null }, "2026-09-07")).toBe(false);
  });

  it("без срока действует, пока не снимут", () => {
    expect(isGlobalNoteActive({ text: "Сегодня выходной", activeUntil: null, updatedAt: null }, "2026-09-07")).toBe(true);
  });

  it("последний день включительно, следующий — уже нет", () => {
    const note = { text: "Сегодня выходной", activeUntil: day("2026-09-07"), updatedAt: null };
    expect(isGlobalNoteActive(note, "2026-09-06")).toBe(true);
    expect(isGlobalNoteActive(note, "2026-09-07")).toBe(true);
    expect(isGlobalNoteActive(note, "2026-09-08")).toBe(false);
  });

  it("текст отдаётся только пока правило действует, и по календарю магазина", () => {
    const note = { text: " Сегодня выходной ", activeUntil: day("2026-09-06"), updatedAt: null };
    // 2026-09-07T05:30Z — в Лос-Анджелесе ещё 6 сентября, значит правило работает.
    expect(activeGlobalNoteText(note, new Date("2026-09-07T05:30:00Z"), "America/Los_Angeles")).toBe("Сегодня выходной");
    // Через сутки — уже нет.
    expect(activeGlobalNoteText(note, new Date("2026-09-08T05:30:00Z"), "America/Los_Angeles")).toBeNull();
  });
});
