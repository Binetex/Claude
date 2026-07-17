import { describe, it, expect } from "vitest";
import { classifyHttpStatus, isRetryableError, IntegrationError } from "./errors";

describe("classifyHttpStatus", () => {
  it("429 → rate_limit", () => expect(classifyHttpStatus(429)).toBe("rate_limit"));
  it("401/403 → auth", () => {
    expect(classifyHttpStatus(401)).toBe("auth");
    expect(classifyHttpStatus(403)).toBe("auth");
  });
  it("5xx → retryable", () => expect(classifyHttpStatus(503)).toBe("retryable"));
  it("прочие 4xx → permanent", () => expect(classifyHttpStatus(422)).toBe("permanent"));
});

describe("IntegrationError.isRetryable / isRetryableError", () => {
  it("retryable и rate_limit повторяемы", () => {
    expect(new IntegrationError("a", { kind: "retryable", platform: "x" }).isRetryable).toBe(true);
    expect(isRetryableError(new IntegrationError("b", { kind: "rate_limit", platform: "x" }))).toBe(true);
  });
  it("auth и permanent не повторяемы", () => {
    expect(isRetryableError(new IntegrationError("c", { kind: "auth", platform: "x" }))).toBe(false);
    expect(isRetryableError(new IntegrationError("d", { kind: "permanent", platform: "x" }))).toBe(false);
  });
  it("обычная ошибка не повторяема", () => {
    expect(isRetryableError(new Error("plain"))).toBe(false);
  });
});
