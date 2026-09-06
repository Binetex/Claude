import { describe, it, expect } from "vitest";
import { prependReadyTimeNote, NOTE_SEPARATOR, hasReadyTime, mentionsTime } from "./note";

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

describe("повтор времени и время в самом сообщении", () => {
  it("то же время в заметке уже есть — второй раз не пишем", () => {
    const note = prependReadyTimeNote("", "around 11am", new Date("2026-09-06T17:13:00Z"), "America/Los_Angeles");
    expect(hasReadyTime(note, "around 11am")).toBe(true);
    expect(hasReadyTime(note, "Around  11AM")).toBe(true);
    expect(hasReadyTime(note, "after 5pm")).toBe(false);
    expect(hasReadyTime("", "after 5pm")).toBe(false);
  });
  it("время берётся только из сообщения, где оно есть", () => {
    for (const t of ["Please deliver it around 11am", "after 5", "tomorrow morning", "I'll be home by noon", "anytime today", "eleven works", "2:30 please", "asap"]) {
      expect(mentionsTime(t)).toBe(true);
    }
    // Цифра в адресе и слово «am» в «I am home» временем не являются: на них прежняя проверка
    // пропускала выдуманное моделью время в заметку и в Telegram.
    for (const t of ["Just buzz the door to get inside", "Thanks!", "Leave it with the doorman", "Apt 4B, gate code 1408", "I am home", "Leave it by the door"]) {
      expect(mentionsTime(t)).toBe(false);
    }
  });
});
