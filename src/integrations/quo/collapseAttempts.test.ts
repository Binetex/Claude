import { describe, it, expect } from "vitest";
import { collapseSendAttempts, attemptGroupKey } from "./collapseAttempts";

type Row = { id: string; status: string; occurredAt: string; sendKey?: string | null };

const row = (id: string, status: string, occurredAt: string, sendKey?: string | null): Row => ({ id, status, occurredAt, sendKey });

describe("attemptGroupKey", () => {
  it("отрезает суффикс попытки", () => {
    expect(attemptGroupKey("auto:order:CUSTOMER:occ:SMS:a0")).toBe("auto:order:CUSTOMER:occ:SMS");
    expect(attemptGroupKey("auto:order:CUSTOMER:occ:SMS:a12")).toBe("auto:order:CUSTOMER:occ:SMS");
  });
  it("ручная отправка и входящие не группируются", () => {
    expect(attemptGroupKey("manual-key-abc")).toBeNull();
    expect(attemptGroupKey(null)).toBeNull();
    expect(attemptGroupKey(undefined)).toBeNull();
    expect(attemptGroupKey("")).toBeNull();
  });
});

describe("collapseSendAttempts", () => {
  it("провал + удачный повтор одного job'а → одно сообщение со статусом успеха", () => {
    const items = [
      row("ok", "DELIVERED", "2026-08-10T15:10:05Z", "job1:a1"),
      row("fail", "FAILED", "2026-08-10T15:10:00Z", "job1:a0"),
    ];
    const res = collapseSendAttempts(items);
    expect(res.map((r) => r.id)).toEqual(["ok"]);
  });

  it("порядок ленты сохраняется, а не пересобирается", () => {
    const items = [
      row("other", "RECEIVED", "2026-08-10T16:00:00Z", null),
      row("fail", "FAILED", "2026-08-10T15:10:00Z", "job1:a0"),
      row("ok", "SENT", "2026-08-10T15:10:05Z", "job1:a1"),
      row("manual", "SENT", "2026-08-10T14:00:00Z", "manual-1"),
    ];
    expect(collapseSendAttempts(items).map((r) => r.id)).toEqual(["other", "ok", "manual"]);
  });

  it("все попытки провалились → остаётся последняя, ошибка не прячется", () => {
    const items = [
      row("a0", "FAILED", "2026-08-10T15:10:00Z", "job1:a0"),
      row("a1", "FAILED", "2026-08-10T15:10:09Z", "job1:a1"),
    ];
    const res = collapseSendAttempts(items);
    expect(res).toHaveLength(1);
    expect(res[0]).toMatchObject({ id: "a1", status: "FAILED" });
  });

  it("разные job'ы не сливаются", () => {
    const items = [
      row("j1", "SENT", "2026-08-10T15:10:00Z", "job1:a0"),
      row("j2", "SENT", "2026-08-10T15:10:01Z", "job2:a0"),
    ];
    expect(collapseSendAttempts(items)).toHaveLength(2);
  });

  it("две ручные отправки с одинаковым текстом остаются двумя сообщениями", () => {
    const items = [
      row("m1", "SENT", "2026-08-10T15:10:00Z", "manual-1"),
      row("m2", "SENT", "2026-08-10T15:11:00Z", "manual-2"),
    ];
    expect(collapseSendAttempts(items)).toHaveLength(2);
  });

  it("DELIVERED важнее SENT в пределах одной отправки", () => {
    const items = [
      row("sent", "SENT", "2026-08-10T15:10:05Z", "job1:a1"),
      row("delivered", "DELIVERED", "2026-08-10T15:10:04Z", "job1:a0"),
    ];
    expect(collapseSendAttempts(items).map((r) => r.id)).toEqual(["delivered"]);
  });
});
