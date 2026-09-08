import { describe, it, expect } from "vitest";
import { backToList, listQuery } from "./backLink";

/**
 * Возврат из карточки обязан приводить в ТОТ ЖЕ список: фильтр живёт в адресе, и потерять его
 * значит заставить человека собирать дату, статус и флориста заново на каждом заказе.
 */
describe("listQuery", () => {
  it("собирает только непустые параметры списка", () => {
    expect(listQuery({ preset: "tomorrow", status: "", floristId: "f1", page: undefined })).toBe(
      "preset=tomorrow&floristId=f1"
    );
  });

  it("пустой список параметров — пустая строка", () => {
    expect(listQuery({})).toBe("");
  });
});

describe("backToList", () => {
  it("возвращает в список с теми же параметрами", () => {
    expect(backToList("/dashboard/orders", "preset=tomorrow&floristId=f1")).toBe(
      "/dashboard/orders?preset=tomorrow&floristId=f1"
    );
  });

  it("параметров нет — обычный список", () => {
    expect(backToList("/dashboard/orders", undefined)).toBe("/dashboard/orders");
    expect(backToList("/dashboard/orders", "")).toBe("/dashboard/orders");
  });

  it("чужой путь в параметре не подменяет наш: пересобираем только пары key=value", () => {
    // Значение приходит из адресной строки, поэтому подставлять его как есть нельзя.
    expect(backToList("/dashboard/orders", "https://evil.example/x?a=1")).toBe(
      "/dashboard/orders?https%3A%2F%2Fevil.example%2Fx%3Fa=1"
    );
  });
});
