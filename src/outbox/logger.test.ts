import { describe, it, expect } from "vitest";
import { safeError } from "./logger";

describe("safeError — обезличивание сообщений об ошибках", () => {
  it("вырезает email и телефон из текста ошибки провайдера", () => {
    const s = safeError(new Error("invalid destination +7 999 123-45-67 for buyer@example.com"));
    expect(s).not.toContain("buyer@example.com");
    expect(s).not.toContain("999");
    expect(s).toContain("[email]");
    expect(s).toContain("[phone]");
  });

  it("усекает длинные сообщения", () => {
    expect(safeError(new Error("x".repeat(500))).length).toBeLessThanOrEqual(301);
  });
});
