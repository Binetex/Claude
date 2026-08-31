import { describe, it, expect } from "vitest";
import { renderTemplate, extractVariables } from "./template";

describe("template.renderTemplate", () => {
  it("подставляет значения переменных", () => {
    const r = renderTemplate("Hi {{name}}, order {{num}}", { name: "Anna", num: "#1" });
    expect(r.text).toBe("Hi Anna, order #1");
    expect(r.missing).toEqual([]);
  });

  it("отсутствующая/пустая переменная → '' (никогда не 'undefined') и попадает в missing", () => {
    const r = renderTemplate("Track: {{tracking_url}} end", { tracking_url: "" });
    expect(r.text).not.toContain("undefined");
    expect(r.missing).toContain("tracking_url");
  });

  it("строка, ставшая пустой из-за подстановки, схлопывается (нет висячих пустых строк)", () => {
    const r = renderTemplate("Hello\n{{tracking_url}}\nBye", {});
    expect(r.text).toBe("Hello\nBye");
  });

  it("extractVariables возвращает уникальные имена в порядке появления", () => {
    expect(extractVariables("{{a}} {{b}} {{a}}")).toEqual(["a", "b"]);
  });
});
