import { describe, it, expect } from "vitest";
import type { OutboxRepository } from "@/outbox/types";
import { publishAssistantIncoming, scheduleAssistantNudge, ASSISTANT_DELAY_SEC, ASSISTANT_NUDGE_ENABLED } from "./events";

/** Репозиторий-заглушка: проверяем ровно то, что кладётся в очередь. */
function fakeRepo() {
  const calls: Record<string, unknown>[] = [];
  const repo = { enqueue: async (r: Record<string, unknown>) => { calls.push(r); return { created: true, id: "e1" }; } } as unknown as OutboxRepository;
  return { repo, calls };
}

const at = new Date("2026-09-06T18:00:00.000Z");

describe("пауза перед разбором", () => {
  it("входящее берётся в работу через минуту — очередь сообщений станет одним ответом", async () => {
    const { repo, calls } = fakeRepo();
    await publishAssistantIncoming(repo, "c1", undefined, at);
    expect(calls[0].availableAt).toEqual(new Date(at.getTime() + ASSISTANT_DELAY_SEC * 1000));
    expect(calls[0].idempotencyKey).toBe("assistant.incoming:c1");
  });

  it("расшифровка звонка — свой ключ, та же пауза", async () => {
    const { repo, calls } = fakeRepo();
    await publishAssistantIncoming(repo, "c1", "transcript", at);
    expect(calls[0].idempotencyKey).toBe("assistant.incoming:c1:transcript");
    expect(calls[0].availableAt).toEqual(new Date(at.getTime() + ASSISTANT_DELAY_SEC * 1000));
  });

  it("напоминание «одну минуту» выключено владельцем — в очередь ничего не ставится", async () => {
    const { repo, calls } = fakeRepo();
    await scheduleAssistantNudge(repo, "t1", at);
    // Включат обратно (ASSISTANT_NUDGE_ENABLED) — проверка встаёт через NUDGE_AFTER_MIN минут.
    expect(ASSISTANT_NUDGE_ENABLED).toBe(false);
    expect(calls).toEqual([]);
  });
});
