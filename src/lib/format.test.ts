/**
 * Окно доставки — свободная строка от магазина или от владельца. Проверяем две вещи:
 * опознанное время выводится по-человечески, а НЕопознанное остаётся дословно.
 */
import { describe, it, expect } from "vitest";
import { fmtTimeWindow } from "./format";

describe("fmtTimeWindow", () => {
  it("24-часовой интервал → AM/PM", () => {
    expect(fmtTimeWindow("12:00 – 16:00")).toBe("12PM – 4PM");
    expect(fmtTimeWindow("14:00–18:00")).toBe("2PM – 6PM");
    expect(fmtTimeWindow("09:00 - 13:00")).toBe("9AM – 1PM");
  });

  it("ровный час без минут: 11AM, а не 11:00AM", () => {
    expect(fmtTimeWindow("11:00")).toBe("11AM");
    expect(fmtTimeWindow("11:30 - 17:00")).toBe("11:30AM – 5PM");
  });

  it("интервал без двоеточий («10-14») тоже читается", () => {
    expect(fmtTimeWindow("10-14")).toBe("10AM – 2PM");
    expect(fmtTimeWindow("12-16")).toBe("12PM – 4PM");
  });

  it("уже AM/PM — нормализуем вид, смысл не меняем", () => {
    expect(fmtTimeWindow("10:00 AM - 2:00 PM")).toBe("10AM – 2PM");
    expect(fmtTimeWindow("11:30 am to 5:45 pm")).toBe("11:30AM – 5:45PM");
    expect(fmtTimeWindow("12:00 AM")).toBe("12AM"); // полночь, не полдень
    expect(fmtTimeWindow("12:00 PM")).toBe("12PM");
  });

  it("непонятное НЕ трогаем — поле свободное", () => {
    for (const raw of ["ASAP", "до обеда", "x", "—", "утро 8-10 или вечер", "25:00 - 30:00", "10:99"]) {
      expect(fmtTimeWindow(raw)).toBe(raw);
    }
  });

  it("пусто → пусто (подпись не должна повиснуть)", () => {
    expect(fmtTimeWindow("")).toBe("");
    expect(fmtTimeWindow(null)).toBe("");
    expect(fmtTimeWindow(undefined)).toBe("");
  });
});
