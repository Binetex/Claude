import { describe, it, expect } from "vitest";
import { createRateLimiter } from "./rateLimiter";

describe("createRateLimiter — ≤N/сек", () => {
  it("пропускает N без ожидания, (N+1)-й ждёт освобождения окна", async () => {
    let t = 0;
    const sleeps: number[] = [];
    const rl = createRateLimiter(2, { now: () => t, sleep: async (ms) => { sleeps.push(ms); t += ms; } });
    await rl.acquire();
    await rl.acquire();
    expect(sleeps).toEqual([]); // первые два — сразу
    await rl.acquire(); // окно заполнено → ждём 1000мс
    expect(sleeps).toEqual([1000]);
  });

  it("после сдвига окна снова пропускает без ожидания", async () => {
    let t = 0;
    const sleeps: number[] = [];
    const rl = createRateLimiter(1, { now: () => t, sleep: async (ms) => { sleeps.push(ms); t += ms; } });
    await rl.acquire(); // t=0
    t += 1000; // прошла секунда
    await rl.acquire(); // старый слот истёк → без ожидания
    expect(sleeps).toEqual([]);
  });
});
