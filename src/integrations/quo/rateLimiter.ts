/**
 * Простой лимитер ≤N запросов/сек (по умолчанию 10 — лимит QUO). Гарантирует, что в любом
 * скользящем окне 1000мс не более N вызовов acquire() прошло дальше. Чистый: sleep/now инъектируются
 * в тестах. Не зависит от сети.
 */
export type RateLimiter = { acquire: () => Promise<void> };

export function createRateLimiter(
  perSecond = 10,
  deps: { now?: () => number; sleep?: (ms: number) => Promise<void> } = {}
): RateLimiter {
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const times: number[] = [];
  return {
    async acquire() {
      for (;;) {
        const t = now();
        // Убираем метки старше 1с.
        while (times.length && t - times[0] >= 1000) times.shift();
        if (times.length < perSecond) {
          times.push(t);
          return;
        }
        // Ждём, пока освободится самый старый слот.
        const waitMs = 1000 - (t - times[0]);
        await sleep(waitMs > 0 ? waitMs : 1);
      }
    },
  };
}
