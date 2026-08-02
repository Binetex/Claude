import { describe, it, expect } from "vitest";
import {
  affectedRange,
  IntervalError,
  leavesNoCoverage,
  planIntervalCorrection,
  planIntervalDeletion,
  type IntervalRow,
} from "./intervals";

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

/** Цепочка из трёх смыкающихся периодов: A[01-01,02-01) B[02-01,03-01) C[03-01,∞). */
const chain: IntervalRow[] = [
  { id: "A", effectiveFrom: d("2026-01-01"), effectiveTo: d("2026-02-01") },
  { id: "B", effectiveFrom: d("2026-02-01"), effectiveTo: d("2026-03-01") },
  { id: "C", effectiveFrom: d("2026-03-01"), effectiveTo: null },
];

describe("исправление даты периода", () => {
  it("сдвиг вперёд сначала сжимает исправляемый период, потом расширяет предыдущий", () => {
    const steps = planIntervalCorrection(chain, "B", d("2026-02-10"));
    // Порядок значим: обратный дал бы наложение A и B на 9 дней.
    expect(steps).toEqual([
      { kind: "SET_FROM", id: "B", effectiveFrom: d("2026-02-10") },
      { kind: "SET_TO", id: "A", effectiveTo: d("2026-02-10") },
    ]);
  });

  it("сдвиг назад сначала сжимает предыдущий период, потом расширяет исправляемый", () => {
    const steps = planIntervalCorrection(chain, "B", d("2026-01-20"));
    expect(steps).toEqual([
      { kind: "SET_TO", id: "A", effectiveTo: d("2026-01-20") },
      { kind: "SET_FROM", id: "B", effectiveFrom: d("2026-01-20") },
    ]);
  });

  it("периоды остаются сомкнутыми: конец предыдущего равен новому началу", () => {
    for (const target of ["2026-01-05", "2026-02-28"]) {
      const steps = planIntervalCorrection(chain, "B", d(target));
      const setTo = steps.find((s) => s.kind === "SET_TO");
      const setFrom = steps.find((s) => s.kind === "SET_FROM");
      expect(setTo).toBeDefined();
      expect((setTo as { effectiveTo: Date }).effectiveTo).toEqual(
        (setFrom as { effectiveFrom: Date }).effectiveFrom
      );
    }
  });

  it("у самой ранней записи предыдущего нет — двигается только она", () => {
    expect(planIntervalCorrection(chain, "A", d("2025-12-01"))).toEqual([
      { kind: "SET_FROM", id: "A", effectiveFrom: d("2025-12-01") },
    ]);
  });

  it("та же дата ничего не меняет", () => {
    expect(planIntervalCorrection(chain, "B", d("2026-02-01"))).toEqual([]);
  });

  it("нельзя заехать за начало предыдущего периода", () => {
    expect(() => planIntervalCorrection(chain, "B", d("2026-01-01"))).toThrow(IntervalError);
    expect(() => planIntervalCorrection(chain, "B", d("2025-12-31"))).toThrow(/позже начала предыдущего/);
  });

  it("нельзя заехать на начало следующего периода", () => {
    expect(() => planIntervalCorrection(chain, "B", d("2026-03-01"))).toThrow(/раньше начала следующего/);
    expect(() => planIntervalCorrection(chain, "B", d("2026-04-01"))).toThrow(IntervalError);
  });

  it("период не может стать пустым", () => {
    const twoRows: IntervalRow[] = [{ id: "X", effectiveFrom: d("2026-01-01"), effectiveTo: d("2026-02-01") }];
    expect(() => planIntervalCorrection(twoRows, "X", d("2026-02-01"))).toThrow(/пустым/);
  });

  it("несуществующая запись — понятная ошибка, а не пустой план", () => {
    expect(() => planIntervalCorrection(chain, "нет", d("2026-02-10"))).toThrow(/не найдена/);
  });
});

describe("удаление периода", () => {
  it("предыдущий период забирает освободившийся отрезок", () => {
    expect(planIntervalDeletion(chain, "B")).toEqual([
      { kind: "DELETE", id: "B" },
      { kind: "SET_TO", id: "A", effectiveTo: d("2026-03-01") },
    ]);
  });

  it("удаление последней записи возвращает предыдущей открытый конец", () => {
    const steps = planIntervalDeletion(chain, "C");
    expect(steps).toEqual([
      { kind: "DELETE", id: "C" },
      { kind: "SET_TO", id: "B", effectiveTo: null },
    ]);
  });

  it("удаление идёт раньше расширения соседа", () => {
    const [first] = planIntervalDeletion(chain, "B");
    expect(first.kind).toBe("DELETE");
  });

  it("у самой ранней записи отрезок покрыть нечем — соседа не трогаем", () => {
    expect(planIntervalDeletion(chain, "A")).toEqual([{ kind: "DELETE", id: "A" }]);
  });

  it("видно, когда настройка исчезает совсем", () => {
    const single: IntervalRow[] = [{ id: "X", effectiveFrom: d("2026-01-01"), effectiveTo: null }];
    expect(leavesNoCoverage(single, "X")).toBe(true);
    expect(leavesNoCoverage(chain, "B")).toBe(false);
  });
});

describe("диапазон затронутых дат", () => {
  it("при удалении — покрытие самой записи", () => {
    expect(affectedRange(chain, "B", {})).toEqual({ from: d("2026-02-01"), to: d("2026-03-01") });
  });

  it("при сдвиге назад захватывает дни по обе стороны границы", () => {
    expect(affectedRange(chain, "B", { nextFrom: d("2026-01-20") })).toEqual({
      from: d("2026-01-20"),
      to: d("2026-03-01"),
    });
  });

  it("при сдвиге вперёд начало остаётся прежним: дни между старой и новой границей тоже меняются", () => {
    expect(affectedRange(chain, "B", { nextFrom: d("2026-02-10") })).toEqual({
      from: d("2026-02-01"),
      to: d("2026-03-01"),
    });
  });

  it("у открытого периода правый край не задан", () => {
    expect(affectedRange(chain, "C", {}).to).toBeNull();
  });
});
