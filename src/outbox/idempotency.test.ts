import { describe, it, expect, vi } from "vitest";
import { runOnce, InMemoryProcessedOperationStore } from "./idempotency";

describe("runOnce — операция выполняется ровно один раз", () => {
  it("первый вызов выполняет fn, второй — пропускает", async () => {
    const store = new InMemoryProcessedOperationStore();
    const fn = vi.fn(async () => "provider-id-1");

    const first = await runOnce(store, { key: "op:1", kind: "sms.send", extractExternalId: (v) => v }, fn);
    const second = await runOnce(store, { key: "op:1", kind: "sms.send", extractExternalId: (v) => v }, fn);

    expect(first).toEqual({ status: "executed", value: "provider-id-1" });
    expect(second.status).toBe("skipped");
    expect(fn).toHaveBeenCalledOnce(); // не выполнено повторно
  });

  it("skipped возвращает сохранённый externalId", async () => {
    const store = new InMemoryProcessedOperationStore();
    await runOnce(store, { key: "op:2", kind: "sms.send", extractExternalId: (v) => v }, async () => "ext-99");
    const again = await runOnce(store, { key: "op:2", kind: "sms.send" }, async () => "should-not-run");
    expect(again).toEqual({ status: "skipped", externalId: "ext-99" });
  });

  it("разные ключи выполняются независимо", async () => {
    const store = new InMemoryProcessedOperationStore();
    const fn = vi.fn(async () => null);
    await runOnce(store, { key: "a", kind: "k" }, fn);
    await runOnce(store, { key: "b", kind: "k" }, fn);
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
