import { describe, it, expect } from "vitest";
import { isUnreadComm, computeIndicators, isLongText, sortTimelineDesc, type CommForIndicator } from "./communicationsView";

describe("isUnreadComm — только входящие SMS и пропущенные звонки (§7)", () => {
  it("входящее SMS без readAt → unread", () => {
    expect(isUnreadComm({ type: "SMS", direction: "INBOUND", status: "RECEIVED", readAt: null })).toBe(true);
  });
  it("исходящее SMS → не unread", () => {
    expect(isUnreadComm({ type: "SMS", direction: "OUTBOUND", status: "DELIVERED", readAt: null })).toBe(false);
  });
  it("пропущенный звонок без readAt → unread", () => {
    expect(isUnreadComm({ type: "CALL", direction: "INBOUND", status: "MISSED", readAt: null })).toBe(true);
  });
  it("отвеченный звонок → не unread", () => {
    expect(isUnreadComm({ type: "CALL", direction: "INBOUND", status: "COMPLETED", readAt: null })).toBe(false);
  });
  it("прочитанное → не unread", () => {
    expect(isUnreadComm({ type: "SMS", direction: "INBOUND", status: "RECEIVED", readAt: new Date() })).toBe(false);
    expect(isUnreadComm({ type: "CALL", direction: "INBOUND", status: "MISSED", readAt: new Date() })).toBe(false);
  });
});

describe("computeIndicators — агрегаты для списка заказов (§16.4)", () => {
  const comms: CommForIndicator[] = [
    { orderId: "o1", type: "SMS", direction: "INBOUND", status: "RECEIVED", readAt: null, occurredAt: "2026-07-20T10:00:00Z", messageText: "Hi, can you please deliver earlier" },
    { orderId: "o1", type: "SMS", direction: "INBOUND", status: "RECEIVED", readAt: null, occurredAt: "2026-07-20T09:00:00Z", messageText: "older" },
    { orderId: "o1", type: "SMS", direction: "OUTBOUND", status: "DELIVERED", readAt: null, occurredAt: "2026-07-20T08:00:00Z", messageText: "sent" },
    { orderId: "o1", type: "CALL", direction: "INBOUND", status: "MISSED", readAt: null, occurredAt: "2026-07-19T12:00:00Z", messageText: null },
    { orderId: "o2", type: "SMS", direction: "INBOUND", status: "RECEIVED", readAt: new Date(), occurredAt: "2026-07-20T07:00:00Z", messageText: "already read" },
  ];
  const ind = computeIndicators(comms);

  it("считает непрочитанные входящие SMS", () => {
    expect(ind.o1.unreadInbound).toBe(2);
    expect(ind.o2.unreadInbound).toBe(0); // прочитано
  });
  it("флаг пропущенного звонка", () => {
    expect(ind.o1.hasMissedUnread).toBe(true);
    expect(ind.o2.hasMissedUnread).toBe(false);
  });
  it("последний контакт и preview — от самого свежего сообщения", () => {
    expect(ind.o1.lastAt).toBe("2026-07-20T10:00:00Z");
    expect(ind.o1.preview).toBe("Hi, can you please deliver earlier");
  });
  it("длинный preview усекается", () => {
    const long = computeIndicators([{ orderId: "o3", type: "SMS", direction: "INBOUND", status: "RECEIVED", readAt: null, occurredAt: "2026-07-20T10:00:00Z", messageText: "x".repeat(80) }]);
    expect(long.o3.preview?.endsWith("…")).toBe(true);
    expect(long.o3.preview!.length).toBeLessThanOrEqual(41);
  });
  it("непривязанные (orderId=null) игнорируются", () => {
    const r = computeIndicators([{ orderId: null, type: "SMS", direction: "INBOUND", status: "RECEIVED", readAt: null, occurredAt: "2026-07-20T10:00:00Z", messageText: "x" }]);
    expect(Object.keys(r)).toHaveLength(0);
  });
});

describe("isLongText / sortTimelineDesc", () => {
  it("длинный текст сворачивается (§16.5)", () => {
    expect(isLongText("a".repeat(301))).toBe(true);
    expect(isLongText("short")).toBe(false);
    expect(isLongText(null)).toBe(false);
  });
  it("лента — новые сверху (§16.1 порядок)", () => {
    const sorted = sortTimelineDesc([{ occurredAt: "2026-07-20T08:00:00Z" }, { occurredAt: "2026-07-20T10:00:00Z" }, { occurredAt: "2026-07-20T09:00:00Z" }]);
    expect(sorted.map((s) => s.occurredAt)).toEqual(["2026-07-20T10:00:00Z", "2026-07-20T09:00:00Z", "2026-07-20T08:00:00Z"]);
  });
});
