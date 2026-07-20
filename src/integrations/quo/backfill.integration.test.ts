import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { runBackfill, BackfillConcurrentError } from "./backfill";
import { reprocessUnlinkedCommunications } from "./communicationsService";
import { quoErrorFromStatus } from "./errors";
import type { QuoClient } from "./client";
import type { QuoMessageObject, QuoCallObject, QuoRecordingObject, QuoTranscriptObject, QuoSummaryObject } from "./types";

const suffix = `quobf-${Date.now()}`;
let siteId: string;
const orderIds: string[] = [];
const STORE_PN = `PN_${suffix}`;
const STORE_NUM = "+13105550000";
let seq = 7000;
const uniquePhone = () => `+1310557${(seq++).toString().padStart(4, "0")}`;
const noLimiter = { acquire: async () => {} };

type FakeData = {
  messages?: Record<string, QuoMessageObject[]>;
  messagePages?: Record<string, { data: QuoMessageObject[]; nextPageToken: string | null }[]>;
  calls?: Record<string, QuoCallObject[]>;
  recordings?: Record<string, QuoRecordingObject[]>;
  transcripts?: Record<string, QuoTranscriptObject>;
  summaries?: Record<string, QuoSummaryObject>;
  listMessagesThrow?: Error;
};
function fakeClient(d: FakeData): QuoClient {
  const msgPageIdx: Record<string, number> = {};
  return {
    async listMessages({ participants, pageToken }) {
      if (d.listMessagesThrow) throw d.listMessagesThrow;
      const p = participants[0];
      const pages = d.messagePages?.[p];
      if (pages) { void pageToken; const i = msgPageIdx[p] ?? 0; msgPageIdx[p] = i + 1; const pg = pages[i]; return { data: pg?.data ?? [], nextPageToken: pg?.nextPageToken ?? null }; }
      return { data: d.messages?.[p] ?? [], nextPageToken: null };
    },
    async listCalls({ participants }) { return { data: d.calls?.[participants[0]] ?? [], nextPageToken: null }; },
    async getCallRecordings(callId) { return d.recordings?.[callId] ?? []; },
    async getCallTranscript(callId) { return d.transcripts?.[callId] ?? null; },
    async getCallSummary(callId) { return d.summaries?.[callId] ?? null; },
    async sendMessage() { throw new Error("nyi"); },
    async getMessage() { return {}; },
    async getCall() { return {}; },
    async listPhoneNumbers() { return []; },
  } as QuoClient;
}

async function makeOrder(senderPhone: string, recipientPhone: string, deliveryOffsetDays = 0): Promise<string> {
  const d = new Date(); d.setUTCHours(0, 0, 0, 0); d.setUTCDate(d.getUTCDate() + deliveryOffsetDays);
  const o = await prisma.order.create({
    data: {
      orderNumber: `#BF-${suffix}-${Math.random().toString(36).slice(2, 8)}`, site: { connect: { id: siteId } },
      platform: "WOOCOMMERCE", source: "Website", externalCreatedAt: new Date(), deliveryDate: d, deliveryWindow: "x",
      senderName: "B", senderPhone, recipientName: "R", recipientPhone, addressLine: "1", city: "SM", zip: "90401",
      itemsTotal: new Prisma.Decimal(1), customerTotal: new Prisma.Decimal(1), paymentStatus: "PAID", orderStatus: "CONFIRMED",
    }, select: { id: true },
  });
  orderIds.push(o.id);
  return o.id;
}
const inMsg = (id: string, from: string) => ({ id, from, to: [STORE_NUM], direction: "incoming" as const, body: "Hi", createdAt: new Date().toISOString() });
const opts = (mode: "DRY_RUN" | "LIVE") => ({ mode, from: new Date(Date.now() - 30 * 864e5), to: new Date(), limiter: noLimiter });

beforeAll(async () => { siteId = (await prisma.site.create({ data: { name: `BF ${suffix}`, shortName: `BF${seq}`, platform: "WOOCOMMERCE", quoPhoneNumberId: STORE_PN, quoPhoneNumber: STORE_NUM } })).id; });
afterAll(async () => {
  await prisma.orderCommunication.deleteMany({ where: { OR: [{ orderId: { in: orderIds } }, { providerPhoneNumberId: STORE_PN }, { storePhone: STORE_NUM }] } });
  await prisma.quoBackfillRun.deleteMany({ where: { quoPhoneNumberId: STORE_PN } });
  await prisma.order.deleteMany({ where: { siteId } });
  await prisma.site.deleteMany({ where: { id: siteId } });
});

describe("runBackfill", () => {
  it("dry-run ничего не пишет (§8.1)", async () => {
    const cust = uniquePhone();
    const orderId = await makeOrder(cust, uniquePhone());
    const client = fakeClient({ messages: { [cust]: [inMsg(`ACdry-${cust}`, cust)] } });
    const rep = await runBackfill(prisma, client, { ...opts("DRY_RUN"), siteId, quoPhoneNumberId: STORE_PN });
    expect(rep.counters.found).toBeGreaterThanOrEqual(1);
    expect(rep.counters.created).toBeGreaterThanOrEqual(1);
    expect(await prisma.orderCommunication.count({ where: { orderId } })).toBe(0); // НИЧЕГО не создано
    const run = await prisma.quoBackfillRun.findUnique({ where: { id: rep.runId } });
    expect(run).toMatchObject({ mode: "DRY_RUN", status: "DONE" });
  });

  it("live импорт создаёт записи и привязывает (§8.2)", async () => {
    const cust = uniquePhone();
    const orderId = await makeOrder(cust, uniquePhone());
    const client = fakeClient({ messages: { [cust]: [inMsg(`AClive-${cust}`, cust)] } });
    await runBackfill(prisma, client, { ...opts("LIVE"), siteId, quoPhoneNumberId: STORE_PN });
    const c = await prisma.orderCommunication.findFirst({ where: { providerResourceId: `AClive-${cust}` } });
    expect(c).toMatchObject({ orderId, direction: "INBOUND", type: "SMS", partyRole: "CUSTOMER" });
  });

  it("повторный live не создаёт дубли (§8.3)", async () => {
    const cust = uniquePhone();
    await makeOrder(cust, uniquePhone());
    const client = fakeClient({ messages: { [cust]: [inMsg(`ACdup-${cust}`, cust)] } });
    await runBackfill(prisma, client, { ...opts("LIVE"), siteId, quoPhoneNumberId: STORE_PN });
    const rep2 = await runBackfill(prisma, client, { ...opts("LIVE"), siteId, quoPhoneNumberId: STORE_PN });
    expect(await prisma.orderCommunication.count({ where: { providerResourceId: `ACdup-${cust}` } })).toBe(1);
    expect(rep2.counters.skipped).toBeGreaterThanOrEqual(1); // повтор → skipped/duplicate
  });

  it("пагинация импортирует все страницы (§8.4)", async () => {
    const cust = uniquePhone();
    await makeOrder(cust, uniquePhone());
    const client = fakeClient({ messagePages: { [cust]: [{ data: [inMsg(`ACp1-${cust}`, cust)], nextPageToken: "p2" }, { data: [inMsg(`ACp2-${cust}`, cust)], nextPageToken: null }] } });
    await runBackfill(prisma, client, { ...opts("LIVE"), siteId, quoPhoneNumberId: STORE_PN });
    expect(await prisma.orderCommunication.count({ where: { providerResourceId: { in: [`ACp1-${cust}`, `ACp2-${cust}`] } } })).toBe(2);
  });

  it("recording/transcript/summary обновляют call, а не создают дубли (§8.8)", async () => {
    const cust = uniquePhone();
    await makeOrder(cust, uniquePhone());
    const callId = `ACcall-${cust}`;
    const client = fakeClient({
      calls: { [cust]: [{ id: callId, from: cust, to: STORE_NUM, direction: "incoming", status: "completed", duration: 20, createdAt: new Date().toISOString() }] },
      recordings: { [callId]: [{ url: "https://rec/1.mp3", type: "audio/mpeg", duration: 20 }] },
      transcripts: { [callId]: { dialogue: [{ content: "Hello" }] } },
      summaries: { [callId]: { summary: ["Asked about delivery"] } },
    });
    await runBackfill(prisma, client, { ...opts("LIVE"), siteId, quoPhoneNumberId: STORE_PN });
    expect(await prisma.orderCommunication.count({ where: { providerResourceId: callId } })).toBe(1);
    const c = await prisma.orderCommunication.findFirst({ where: { providerResourceId: callId } });
    expect(c).toMatchObject({ recordingUrl: "https://rec/1.mp3", transcript: "Hello", summary: "Asked about delivery" });
  });

  it("неоднозначное событие остаётся непривязанным (§8.9)", async () => {
    const cust = uniquePhone();
    await makeOrder(cust, uniquePhone(), -1);
    await makeOrder(cust, uniquePhone(), 1); // равноудалённые от полуночи → ambiguous
    const mid = new Date(); mid.setUTCHours(0, 0, 0, 0);
    const client = fakeClient({ messages: { [cust]: [{ id: `ACamb-${cust}`, from: cust, to: [STORE_NUM], direction: "incoming", body: "?", createdAt: mid.toISOString() }] } });
    const rep = await runBackfill(prisma, client, { ...opts("LIVE"), siteId, quoPhoneNumberId: STORE_PN });
    const c = await prisma.orderCommunication.findFirst({ where: { providerResourceId: `ACamb-${cust}` } });
    expect(c?.orderId).toBeNull();
    expect(rep.counters.unlinked).toBeGreaterThanOrEqual(1);
  });

  it("ранее непривязанное можно привязать при повторной обработке (§8.10)", async () => {
    // Непривязанное событие (orderId=null), затем появляется подходящий заказ → reprocess привязывает.
    const cust = uniquePhone();
    const comm = await prisma.orderCommunication.create({
      data: { provider: "QUO", providerEventId: `EVrelink-${cust}`, providerResourceId: `ACrelink-${cust}`, type: "SMS", direction: "INBOUND", status: "RECEIVED", partyRole: "UNKNOWN", externalPhone: cust, externalPhoneNormalized: cust, occurredAt: new Date() },
      select: { id: true },
    });
    expect((await prisma.orderCommunication.findUnique({ where: { id: comm.id } }))!.orderId).toBeNull();
    const orderId = await makeOrder(cust, uniquePhone());
    const res = await reprocessUnlinkedCommunications(prisma, {});
    expect(res.linked).toBeGreaterThanOrEqual(1);
    const after = await prisma.orderCommunication.findUnique({ where: { id: comm.id } });
    expect(after?.orderId).toBe(orderId);
    expect(after?.partyRole).toBe("CUSTOMER"); // UNKNOWN → уточнён при привязке
  });

  it("два одновременных LIVE-запуска не выполняются параллельно (§8.11)", async () => {
    // Держим лок: активный LIVE-run.
    const lock = await prisma.quoBackfillRun.create({ data: { mode: "LIVE", status: "RUNNING", fromAt: new Date(), toAt: new Date(), quoPhoneNumberId: STORE_PN, activeLock: "ACTIVE" }, select: { id: true } });
    try {
      await expect(runBackfill(prisma, fakeClient({}), { ...opts("LIVE"), siteId, quoPhoneNumberId: STORE_PN })).rejects.toBeInstanceOf(BackfillConcurrentError);
    } finally {
      await prisma.quoBackfillRun.update({ where: { id: lock.id }, data: { activeLock: null, status: "DONE" } });
    }
  });

  it("401 останавливает запуск, run FAILED (§8.7)", async () => {
    const cust = uniquePhone();
    await makeOrder(cust, uniquePhone());
    const client = fakeClient({ listMessagesThrow: quoErrorFromStatus(401) });
    await expect(runBackfill(prisma, client, { ...opts("LIVE"), siteId, quoPhoneNumberId: STORE_PN })).rejects.toMatchObject({ kind: "auth" });
    const failed = await prisma.quoBackfillRun.findFirst({ where: { quoPhoneNumberId: STORE_PN, status: "FAILED" }, orderBy: { startedAt: "desc" } });
    expect(failed).toBeTruthy();
    expect(failed?.safeError).toContain("unauthorized");
  });
});
