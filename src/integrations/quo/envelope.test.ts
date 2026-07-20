import { describe, it, expect } from "vitest";
import { parseQuoWebhook } from "./envelope";

const STORE = "+13105550000";
const CUST = "+13105551234";

function env(type: string, object: Record<string, unknown>, id = "EV_1") {
  return { id, object: "event", apiVersion: "v3", createdAt: "2026-07-20T15:00:00.000Z", type, data: { object } };
}

describe("parseQuoWebhook", () => {
  it("message.received → SMS INBOUND RECEIVED, externalPhone=from", () => {
    const e = parseQuoWebhook(env("message.received", { id: "AC1", from: CUST, to: [STORE], direction: "incoming", body: "Hi", status: "received", createdAt: "2026-07-20T15:00:00Z", phoneNumberId: "PN1", conversationId: "CN1", userId: null }));
    expect(e).toMatchObject({ providerEventId: "EV_1", kind: "message", type: "SMS", direction: "INBOUND", status: "RECEIVED", externalPhone: CUST, storePhone: STORE, messageText: "Hi", resourceId: "AC1", phoneNumberId: "PN1", conversationId: "CN1" });
  });

  it("message.delivered → SMS OUTBOUND DELIVERED, externalPhone=to[0]", () => {
    const e = parseQuoWebhook(env("message.delivered", { id: "AC2", from: STORE, to: [CUST], direction: "outgoing", body: "Your order is ready", status: "delivered", userId: "US1" }));
    expect(e).toMatchObject({ kind: "message", type: "SMS", direction: "OUTBOUND", status: "DELIVERED", externalPhone: CUST, storePhone: STORE, userId: "US1" });
  });

  it("MMS media парсится", () => {
    const e = parseQuoWebhook(env("message.received", { id: "AC3", from: CUST, to: [STORE], direction: "incoming", body: "", media: [{ url: "https://m/1.jpg", type: "image/jpeg" }] }));
    expect(e?.media).toEqual([{ url: "https://m/1.jpg", type: "image/jpeg" }]);
  });

  it("call.completed отвеченный → CALL COMPLETED с длительностью", () => {
    const e = parseQuoWebhook(env("call.completed", { id: "AC4", from: CUST, to: STORE, direction: "incoming", status: "completed", duration: 42, answeredAt: "2026-07-20T15:00:05Z", completedAt: "2026-07-20T15:00:47Z", userId: "US1" }));
    expect(e).toMatchObject({ kind: "call", type: "CALL", direction: "INBOUND", status: "COMPLETED", externalPhone: CUST, storePhone: STORE, durationSeconds: 42, resourceId: "AC4" });
  });

  it("call.completed пропущенный (no-answer/missed) → MISSED", () => {
    for (const status of ["missed", "no-answer"]) {
      const e = parseQuoWebhook(env("call.completed", { id: "AC5", from: CUST, to: STORE, direction: "incoming", status }));
      expect(e).toMatchObject({ kind: "call", status: "MISSED", direction: "INBOUND" });
    }
  });

  it("исходящий звонок → externalPhone=to", () => {
    const e = parseQuoWebhook(env("call.completed", { id: "AC6", from: STORE, to: CUST, direction: "outgoing", status: "completed" }));
    expect(e).toMatchObject({ direction: "OUTBOUND", externalPhone: CUST, storePhone: STORE });
  });

  it("звонок с voicemail → type VOICEMAIL", () => {
    const e = parseQuoWebhook(env("call.completed", { id: "AC7", from: CUST, to: STORE, direction: "incoming", status: "no-answer", voicemail: { url: "https://vm/1.mp3", duration: 12 } }));
    expect(e).toMatchObject({ type: "VOICEMAIL", recordingUrl: "https://vm/1.mp3", durationSeconds: 12 });
  });

  it("call.ringing → kind call_ringing, status PENDING", () => {
    const e = parseQuoWebhook(env("call.ringing", { id: "AC8", from: CUST, to: STORE, direction: "incoming", status: "ringing" }));
    expect(e).toMatchObject({ kind: "call_ringing", status: "PENDING" });
  });

  it("call.recording.completed → kind recording, resourceId=callId, recordingUrl", () => {
    const e = parseQuoWebhook(env("call.recording.completed", { callId: "AC4", url: "https://rec/1.mp3", type: "audio/mpeg", duration: 40, status: "completed" }));
    expect(e).toMatchObject({ kind: "recording", resourceId: "AC4", recordingUrl: "https://rec/1.mp3", durationSeconds: 40 });
  });

  it("call.transcript.completed → kind transcript, текст из dialogue", () => {
    const e = parseQuoWebhook(env("call.transcript.completed", { callId: "AC4", dialogue: [{ content: "Hello", userId: "US1" }, { content: "Hi there" }], status: "completed" }));
    expect(e).toMatchObject({ kind: "transcript", resourceId: "AC4", transcript: "Hello\nHi there" });
  });

  it("call.summary.completed → kind summary", () => {
    const e = parseQuoWebhook(env("call.summary.completed", { callId: "AC4", summary: ["Customer asked about delivery", "Promised update"], status: "completed" }));
    expect(e).toMatchObject({ kind: "summary", resourceId: "AC4", summary: "Customer asked about delivery\nPromised update" });
  });

  it("неизвестный тип / нет id → null", () => {
    expect(parseQuoWebhook(env("contact.updated", { id: "CT1" }))).toBeNull();
    expect(parseQuoWebhook({ object: "event", type: "message.received", data: { object: { from: CUST } } })).toBeNull(); // нет id
    expect(parseQuoWebhook("not json")).toBeNull();
  });

  it("принимает как объект, так и raw JSON-строку", () => {
    const raw = JSON.stringify(env("message.received", { id: "AC9", from: CUST, to: [STORE], direction: "incoming", body: "x" }));
    expect(parseQuoWebhook(raw)?.resourceId).toBe("AC9");
  });
});

// ── Регрессия на РЕАЛЬНЫХ объектах QUO API (live-тест TheFlow, воркспейс без from/to в call.*) ──
describe("parseQuoWebhook — реальные объекты звонков QUO", () => {
  it("отвеченный входящий (from/to отсутствуют, только participants) → external из participants, COMPLETED", () => {
    const e = parseQuoWebhook(env("call.completed", {
      id: "ACaa7f20", direction: "incoming", status: "completed",
      participants: [CUST, STORE], duration: 18,
      answeredAt: "2026-07-20T16:19:44.690Z", completedAt: "2026-07-20T16:20:02.609Z", createdAt: "2026-07-20T16:19:05.918Z",
    }));
    expect(e).toMatchObject({ kind: "call", type: "CALL", direction: "INBOUND", status: "COMPLETED", externalPhone: CUST, storePhone: STORE, durationSeconds: 18 });
  });

  it("пропущенный входящий (status=completed, answeredAt=null, duration=0, participants=[]) → MISSED, external='' (номер не выдумываем)", () => {
    const e = parseQuoWebhook(env("call.completed", {
      id: "ACbe15ac", direction: "incoming", status: "completed",
      participants: [], duration: 0, answeredAt: null, completedAt: "2026-07-20T16:16:40.172Z", createdAt: "2026-07-20T16:16:32.348Z",
    }));
    expect(e).toMatchObject({ kind: "call", type: "CALL", direction: "INBOUND", status: "MISSED", externalPhone: "" });
  });

  it("self-call артефакт (outgoing на свой же номер, answeredAt=null, duration=6) → external=номер магазина, OUTBOUND (ingest его отфильтрует)", () => {
    const e = parseQuoWebhook(env("call.completed", {
      id: "AC4e392a", direction: "outgoing", status: "completed",
      to: STORE, participants: [STORE], duration: 6, answeredAt: null,
      completedAt: "2026-07-20T16:16:07.953Z", createdAt: "2026-07-20T16:16:03.057Z", phoneNumberId: "PNUqzT3K0J",
    }));
    expect(e).toMatchObject({ kind: "call", direction: "OUTBOUND", externalPhone: STORE, phoneNumberId: "PNUqzT3K0J" });
  });

  it("отвеченный без длительности (робот принял мгновенно): answeredAt задан → НЕ missed", () => {
    const e = parseQuoWebhook(env("call.completed", {
      id: "ACrobot", direction: "incoming", status: "completed",
      participants: [CUST, STORE], duration: 0, answeredAt: "2026-07-20T16:30:00Z",
    }));
    expect(e).toMatchObject({ direction: "INBOUND", status: "COMPLETED" });
  });
});
