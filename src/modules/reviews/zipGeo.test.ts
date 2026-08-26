import { describe, it, expect } from "vitest";
import { zipCoords, zipDistanceMiles } from "./zipGeo";

/**
 * Таблица координат — данные, а не логика, поэтому проверяем её на известных наперёд фактах:
 * реальные индексы Лос-Анджелеса и расстояния между ними, которые легко сверить по карте.
 */
describe("координаты индекса", () => {
  it("находит настоящие индексы Лос-Анджелеса", () => {
    const downtown = zipCoords("90017");
    expect(downtown).not.toBeNull();
    expect(downtown!.lat).toBeCloseTo(34.05, 1);
    expect(downtown!.lng).toBeCloseTo(-118.26, 1);
  });

  it("неизвестный индекс даёт null, а не выдуманную точку", () => {
    // Абонентские ящики и новые коды в таблице отсутствуют — это обычное дело, не ошибка.
    expect(zipCoords("00000")).toBeNull();
    expect(zipCoords("99999")).toBeNull();
    expect(zipCoords("9001")).toBeNull();
    expect(zipCoords("abcde")).toBeNull();
  });
});

describe("расстояние между индексами", () => {
  it("считает знакомые расстояния по Лос-Анджелесу", () => {
    // Даунтаун (90017) — Mar Vista (90066): порядка десяти миль по прямой.
    const d = zipDistanceMiles("90017", "90066")!;
    expect(d).toBeGreaterThan(7);
    expect(d).toBeLessThan(13);
  });

  it("соседние индексы ближе далёких — на этом и держится выбор точки", () => {
    const near = zipDistanceMiles("90066", "90064")!;
    const far = zipDistanceMiles("90066", "90017")!;
    expect(near).toBeLessThan(far);
  });

  it("расстояние до самого себя — ноль", () => {
    expect(zipDistanceMiles("90017", "90017")).toBe(0);
  });

  it("Лос-Анджелес и Нью-Йорк — около двух с половиной тысяч миль", () => {
    const d = zipDistanceMiles("90017", "10001")!;
    expect(d).toBeGreaterThan(2300);
    expect(d).toBeLessThan(2600);
  });

  it("неизвестный индекс даёт null, а не ноль", () => {
    // Ноль означал бы «это здесь же» и увёл бы заказ к случайной точке.
    expect(zipDistanceMiles("90017", "00000")).toBeNull();
  });
});
