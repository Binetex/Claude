import { describe, it, expect } from "vitest";
import { PRINT_CSS } from "./printCss";

describe("print CSS (§14: 13,14)", () => {
  it("13) использует US Letter, а не A4", () => {
    expect(PRINT_CSS).toContain("@page");
    expect(PRINT_CSS).toContain("size: Letter portrait");
    expect(PRINT_CSS).not.toMatch(/A4/i);
  });

  it("половина = 8.5×5.5in, лист = 8.5×11in (в дюймах)", () => {
    expect(PRINT_CSS).toMatch(/\.half\s*\{[^}]*width:\s*8\.5in/);
    expect(PRINT_CSS).toMatch(/\.half\s*\{[^}]*height:\s*5\.5in/);
    expect(PRINT_CSS).toMatch(/\.sheet\s*\{[^}]*width:\s*8\.5in/);
    expect(PRINT_CSS).toMatch(/\.sheet\s*\{[^}]*height:\s*11in/);
  });

  it("14) в печати скрыты управляющие элементы (.no-print)", () => {
    expect(PRINT_CSS).toMatch(/@media print\s*\{[^}]*\.no-print\s*\{\s*display:\s*none/);
  });

  it("между половинами — пунктирная линия разреза", () => {
    expect(PRINT_CSS).toMatch(/\.cut-line\s*\{[^}]*dashed/);
  });
});
