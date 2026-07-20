import { describe, it, expect, vi } from "vitest";
import crypto from "node:crypto";
import { intakeQuoWebhook, type QuoEnqueue } from "./webhookIntake";

const KEY_A = Buffer.from("signing-key-A-000000000000000000").toString("base64");
const KEY_B = Buffer.from("signing-key-B-111111111111111111").toString("base64");
const NOW = 1_700_000_000_000;
const CUST = "+13105551234";
const STORE = "+13105550000";

function sign(rawBody: string, keyB64: string, tsMs = NOW): string {
  const sig = crypto.createHmac("sha256", Buffer.from(keyB64, "base64")).update(`${tsMs}.${rawBody}`).digest("base64");
  return `hmac;1;${tsMs};${sig}`;
}

function body(type: string, object: Record<string, unknown>, id = "EV_1"): string {
  return JSON.stringify({ id, object: "event", apiVersion: "v3", createdAt: "2026-07-20T15:00:00Z", type, data: { object } });
}

const msgBody = body("message.received", { id: "AC1", from: CUST, to: [STORE], direction: "incoming", body: "SECRET TEXT 123" });

function fakeEnqueue() {
  const seen = new Set<string>();
  const calls: { idempotencyKey: string; payload: unknown; eventType: string }[] = [];
  const enqueue: QuoEnqueue = async (e) => {
    calls.push({ idempotencyKey: e.idempotencyKey, payload: e.payload, eventType: e.eventType });
    const dup = seen.has(e.idempotencyKey);
    if (!dup) seen.add(e.idempotencyKey);
    return { created: !dup };
  };
  return { enqueue, calls };
}

describe("intakeQuoWebhook", () => {
  it("валидная подпись + известное событие → 200, durable enqueue с ключом идемпотентности", async () => {
    const q = fakeEnqueue();
    const res = await intakeQuoWebhook(msgBody, sign(msgBody, KEY_A), { signingKeys: [KEY_A], enqueue: q.enqueue, nowMs: NOW });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ received: true, duplicate: false });
    expect(q.calls).toHaveLength(1);
    expect(q.calls[0]).toMatchObject({ eventType: "quo.webhook.received", idempotencyKey: "quo:webhook:EV_1" });
  });

  it("невалидная подпись → 401, без enqueue", async () => {
    const q = fakeEnqueue();
    const res = await intakeQuoWebhook(msgBody, sign(msgBody, KEY_B) /* чужой ключ */, { signingKeys: [KEY_A], enqueue: q.enqueue, nowMs: NOW });
    expect(res.status).toBe(401);
    expect(q.calls).toHaveLength(0);
  });

  it("отсутствует подпись → 401", async () => {
    const q = fakeEnqueue();
    const res = await intakeQuoWebhook(msgBody, null, { signingKeys: [KEY_A], enqueue: q.enqueue, nowMs: NOW });
    expect(res.status).toBe(401);
    expect(q.calls).toHaveLength(0);
  });

  it("старый timestamp (replay) → 401", async () => {
    const q = fakeEnqueue();
    const oldHeader = sign(msgBody, KEY_A, NOW - 10 * 60 * 1000);
    const res = await intakeQuoWebhook(msgBody, oldHeader, { signingKeys: [KEY_A], enqueue: q.enqueue, nowMs: NOW });
    expect(res.status).toBe(401);
    expect(q.calls).toHaveLength(0);
  });

  it("ротация ключей: подпись старым ключом всё ещё валидна, если он в списке", async () => {
    const q = fakeEnqueue();
    const res = await intakeQuoWebhook(msgBody, sign(msgBody, KEY_B), { signingKeys: [KEY_A, KEY_B], enqueue: q.enqueue, nowMs: NOW });
    expect(res.status).toBe(200);
  });

  it("повторная доставка того же event → второй раз duplicate:true, дубль не создаётся", async () => {
    const q = fakeEnqueue();
    const h = sign(msgBody, KEY_A);
    const r1 = await intakeQuoWebhook(msgBody, h, { signingKeys: [KEY_A], enqueue: q.enqueue, nowMs: NOW });
    const r2 = await intakeQuoWebhook(msgBody, h, { signingKeys: [KEY_A], enqueue: q.enqueue, nowMs: NOW });
    expect(r1.body.duplicate).toBe(false);
    expect(r2.body.duplicate).toBe(true);
    expect(q.calls).toHaveLength(2); // enqueue вызван дважды, но по одному idempotencyKey (дедуп в outbox)
    expect(new Set(q.calls.map((c) => c.idempotencyKey)).size).toBe(1);
  });

  it("неизвестный тип события → 200 ignored, без enqueue", async () => {
    const q = fakeEnqueue();
    const unknown = body("contact.updated", { id: "CT1" });
    const res = await intakeQuoWebhook(unknown, sign(unknown, KEY_A), { signingKeys: [KEY_A], enqueue: q.enqueue, nowMs: NOW });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ignored: true });
    expect(q.calls).toHaveLength(0);
  });

  it("логи не содержат полного телефона и текста сообщения (PII-safe)", async () => {
    const q = fakeEnqueue();
    const log = vi.fn();
    await intakeQuoWebhook(msgBody, sign(msgBody, KEY_A), { signingKeys: [KEY_A], enqueue: q.enqueue, nowMs: NOW, log });
    const dump = JSON.stringify(log.mock.calls);
    expect(dump).not.toContain(CUST); // полный номер
    expect(dump).not.toContain("3105551234"); // цифры номера без +
    expect(dump).not.toContain("SECRET TEXT 123"); // текст сообщения
    expect(dump).toContain("***1234"); // маскированный номер присутствует
  });
});
