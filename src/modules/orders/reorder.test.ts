import { describe, it, expect } from "vitest";

/**
 * Перестановка в очереди дня — чистая работа со списком, и ошибиться в ней можно ровно в двух
 * местах: сдвиг индексов после удаления и вставка «до» против «после» соседа. Обе проверяем
 * здесь, без базы; сама moveOrderInDay из этого и состоит.
 */
function move(seq: string[], id: string, direction: "up" | "down", visible: string[]): string[] {
  const out = [...seq];
  const from = out.indexOf(id);
  const vis = visible.filter((v) => out.includes(v));
  const at = vis.indexOf(id);
  const neighbour = at === -1 ? undefined : vis[direction === "up" ? at - 1 : at + 1];
  if (!neighbour) return out;
  const [moving] = out.splice(from, 1);
  const target = out.indexOf(neighbour);
  out.splice(direction === "up" ? target : target + 1, 0, moving!);
  return out;
}

const DAY = ["a", "b", "c", "d"];

describe("очередь дня", () => {
  it("вверх меняет местами с соседом сверху", () => {
    expect(move(DAY, "c", "up", DAY)).toEqual(["a", "c", "b", "d"]);
  });

  it("вниз меняет местами с соседом снизу", () => {
    expect(move(DAY, "b", "down", DAY)).toEqual(["a", "c", "b", "d"]);
  });

  it("с краёв не уезжает", () => {
    expect(move(DAY, "a", "up", DAY)).toEqual(DAY);
    expect(move(DAY, "d", "down", DAY)).toEqual(DAY);
  });

  it("первый вниз и последний вверх работают", () => {
    expect(move(DAY, "a", "down", DAY)).toEqual(["b", "a", "c", "d"]);
    expect(move(DAY, "d", "up", DAY)).toEqual(["a", "b", "d", "c"]);
  });

  it("при фильтре двигает к ВИДИМОМУ соседу, перепрыгивая скрытые", () => {
    // На экране видно только a и d (b и c отфильтрованы). «d вверх» обязан встать перед a,
    // а не поменяться местами с невидимым c: человек двигает то, на что смотрит.
    expect(move(DAY, "d", "up", ["a", "d"])).toEqual(["d", "a", "b", "c"]);
  });

  it("невидимый заказ не двигается", () => {
    expect(move(DAY, "b", "up", ["a", "d"])).toEqual(DAY);
  });

  it("список из одного не ломается", () => {
    expect(move(["a"], "a", "up", ["a"])).toEqual(["a"]);
    expect(move(["a"], "a", "down", ["a"])).toEqual(["a"]);
  });
});
