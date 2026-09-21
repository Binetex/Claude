import { describe, it, expect } from "vitest";

/**
 * Раскладка присланного порядка по позициям дня — вся суть saveDayQueue.
 *
 * Хитрость одна: при включённом фильтре человек переставляет ТОЛЬКО видимые заказы, а скрытые
 * обязаны остаться там же, где стояли. Поэтому видимые меняются местами между собственными
 * позициями в общей последовательности, а не сдвигают всё подряд.
 */
function apply(daySeq: string[], incoming: string[]): string[] {
  const inDay = new Set(daySeq);
  const list = incoming.filter((id) => inDay.has(id));
  const moving = new Set(list);
  const out = [...daySeq];
  const slots: number[] = [];
  out.forEach((id, i) => {
    if (moving.has(id)) slots.push(i);
  });
  slots.forEach((slot, k) => {
    out[slot] = list[k]!;
  });
  return out;
}

const DAY = ["a", "b", "c", "d"];

describe("сохранение очереди дня", () => {
  it("весь день переставлен — порядок ровно такой, как прислали", () => {
    expect(apply(DAY, ["c", "a", "d", "b"])).toEqual(["c", "a", "d", "b"]);
  });

  it("переезд с последнего места на первое за одно сохранение", () => {
    expect(apply(DAY, ["d", "a", "b", "c"])).toEqual(["d", "a", "b", "c"]);
  });

  it("при фильтре скрытые заказы остаются на своих местах", () => {
    // Видно только a и d (позиции 0 и 3). Меняем их местами: b и c не шевелятся.
    expect(apply(DAY, ["d", "a"])).toEqual(["d", "b", "c", "a"]);
  });

  it("заказ, уехавший из дня, пока расставляли, просто игнорируется", () => {
    expect(apply(DAY, ["c", "a", "ЧУЖОЙ"])).toEqual(["c", "b", "a", "d"]);
  });

  it("пустой список ничего не меняет", () => {
    expect(apply(DAY, [])).toEqual(DAY);
  });

  it("день из одного заказа не ломается", () => {
    expect(apply(["a"], ["a"])).toEqual(["a"]);
  });
});
