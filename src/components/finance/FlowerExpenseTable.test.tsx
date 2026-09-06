import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { FlowerExpenseTable } from "./FlowerExpenseTable";
import type { FlowerExpenseRow } from "@/modules/finance/flowerExpenses";
import { todayStrInTz, DEFAULT_STORE_TZ } from "@/lib/tz";

/**
 * «Закупки не было» — только у ПРОШЕДШЕГО дня без записи. Сегодня закупка ещё может случиться,
 * а заполненному дню ноль ставить нечем: там уже есть сумма и «Изменить».
 */
const actions = { save: async () => ({}), remove: async () => ({}), preview: async () => ({}) };

function row(day: string, expense: boolean): FlowerExpenseRow {
  return {
    day,
    expense: expense
      ? { id: "e1", amountCents: 12000, currency: "USD", comment: null, createdBy: "u1", createdByName: "Owner", createdAt: new Date("2026-08-05T13:00:00Z"), updatedBy: null, updatedByName: null, updatedAt: new Date("2026-08-05T13:00:00Z") }
      : null,
    status: expense ? "COUNTED" : "MISSING",
    ordersTotal: 3,
    complete: expense,
    calculated: expense,
    distributableCents: 0,
    shareCents: expense ? 5000 : null,
  };
}

const render = (rows: FlowerExpenseRow[]) => renderToStaticMarkup(<FlowerExpenseTable rows={rows} actions={actions} hrefBase="/x" />);

describe("кнопка «Закупки не было»", () => {
  it("есть у прошедшего дня без записи", () => {
    expect(render([row("2026-08-04", false)])).toContain("Закупки не было");
  });
  it("нет у сегодняшнего дня и у заполненного", () => {
    expect(render([row(todayStrInTz(DEFAULT_STORE_TZ), false)])).not.toContain("Закупки не было");
    expect(render([row("2026-08-04", true)])).not.toContain("Закупки не было");
  });
});
