import { describe, it, expect, vi } from "vitest";
import { runWithRetry, computeBackoffMs } from "./retry";
import { IntegrationError } from "./errors";

const noSleep = async () => {};
const retryable = () => new IntegrationError("temp", { kind: "retryable", platform: "test" });
const permanent = () => new IntegrationError("bad", { kind: "permanent", platform: "test" });

describe("runWithRetry", () => {
  it("возвращает результат без повторов при успехе", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    await expect(runWithRetry(fn, { sleep: noSleep })).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("повторяет ретраябельную ошибку и в итоге успевает", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(retryable())
      .mockRejectedValueOnce(retryable())
      .mockResolvedValue("ok");
    await expect(runWithRetry(fn, { sleep: noSleep, rand: () => 0 })).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("НЕ повторяет permanent-ошибку", async () => {
    const fn = vi.fn().mockRejectedValue(permanent());
    await expect(runWithRetry(fn, { sleep: noSleep })).rejects.toBeInstanceOf(IntegrationError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("пробрасывает последнюю ошибку после исчерпания попыток", async () => {
    const fn = vi.fn().mockRejectedValue(retryable());
    await expect(
      runWithRetry(fn, { sleep: noSleep, rand: () => 0, policy: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 10 } })
    ).rejects.toBeInstanceOf(IntegrationError);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("уважает retryAfterMs из ошибки", async () => {
    const sleep = vi.fn(noSleep);
    const err = new IntegrationError("rl", { kind: "rate_limit", platform: "test", retryAfterMs: 1234 });
    const fn = vi.fn().mockRejectedValueOnce(err).mockResolvedValue("ok");
    await runWithRetry(fn, { sleep });
    expect(sleep).toHaveBeenCalledWith(1234);
  });
});

describe("computeBackoffMs", () => {
  it("растёт экспоненциально и ограничен maxDelay", () => {
    const policy = { maxAttempts: 5, baseDelayMs: 100, maxDelayMs: 1000 };
    expect(computeBackoffMs(1, policy, () => 1)).toBe(100);
    expect(computeBackoffMs(2, policy, () => 1)).toBe(200);
    expect(computeBackoffMs(10, policy, () => 1)).toBe(1000); // clamp
  });
  it("полный джиттер: 0 при rand=0", () => {
    expect(computeBackoffMs(3, { maxAttempts: 5, baseDelayMs: 100, maxDelayMs: 5000 }, () => 0)).toBe(0);
  });
});
