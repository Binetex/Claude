import "server-only";
/**
 * Безопасный backfill истории QUO за ограниченный период. Ключевое:
 *  - DRY-RUN по умолчанию (никаких записей — только план через planQuoEvent);
 *  - order-driven: список messages/calls QUO ТРЕБУЕТ participants, поэтому собеседников берём из
 *    телефонов заказов магазина за период (E.164). Коммуникации с номерами вне заказов недоступны
 *    через list-API — это ограничение контракта QUO (см. live-checklist);
 *  - пагинация строго по контракту (pageToken); rate-limit ≤10 req/s; retry 429/5xx — на клиенте;
 *  - идемпотентность: синтетический стабильный providerEventId `quo:backfill:{kind}:{resourceId}` +
 *    dedup по resourceId (повторный backfill/пересечение с webhook не создаёт дублей);
 *  - recording/transcript/summary ОБНОВЛЯЮТ существующий call (через ingest enrichment);
 *  - привязка к заказам — существующим matcher'ом; неоднозначные → orderId=null;
 *  - история запусков в QuoBackfillRun + лок одного LIVE-запуска (activeLock @unique);
 *  - 401/403 останавливают запуск; PII/секреты в safeError/логи не попадают.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import type { QuoClient } from "./client";
import { QuoApiError } from "./errors";
import { toE164 } from "@/lib/phone";
import { parseQuoWebhook } from "./envelope";
import { ingestQuoEvent } from "./ingest";
import { planQuoEvent } from "./plan";
import { createRateLimiter, type RateLimiter } from "./rateLimiter";
import { quoLog } from "./logging";
import type { NormalizedQuoEvent, QuoMessageObject, QuoCallObject, QuoRecordingObject, QuoTranscriptObject, QuoSummaryObject } from "./types";

export class BackfillConcurrentError extends Error {
  constructor() {
    super("another live backfill is already running");
    this.name = "BackfillConcurrentError";
  }
}

export type BackfillMode = "DRY_RUN" | "LIVE";
export type BackfillOptions = {
  mode: BackfillMode;
  from: Date;
  to: Date;
  siteId?: string;
  quoPhoneNumberId?: string;
  initiatedByUserId?: string | null;
  limiter?: RateLimiter;
  maxParticipantsPerSite?: number;
  maxResults?: number;
};
export type BackfillCounters = { found: number; created: number; updated: number; skipped: number; unlinked: number; errors: number };
export type BackfillReport = { runId: string; mode: BackfillMode; counters: BackfillCounters; breakdown: { byType: Record<string, number>; bySite: Record<string, number> }; sites: string[] };

const P2002 = (e: unknown) => !!e && typeof e === "object" && "code" in e && (e as { code?: string }).code === "P2002";

function safeError(err: unknown): string {
  if (err instanceof QuoApiError) return err.message; // без секретов
  if (err instanceof Error) return err.name;
  return "error";
}

async function getParticipants(prisma: PrismaClient, siteId: string, from: Date, to: Date, cap: number): Promise<string[]> {
  const margin = 7 * 24 * 3600 * 1000;
  const lo = new Date(from.getTime() - margin);
  const hi = new Date(to.getTime() + margin);
  const orders = await prisma.order.findMany({
    where: { siteId, OR: [{ createdAt: { gte: lo, lte: hi } }, { deliveryDate: { gte: lo, lte: hi } }] },
    select: { senderPhone: true, recipientPhone: true },
    take: cap,
  });
  const set = new Set<string>();
  for (const o of orders) {
    const s = toE164(o.senderPhone);
    if (s) set.add(s);
    const r = toE164(o.recipientPhone);
    if (r) set.add(r);
  }
  return [...set];
}

async function paginate<T>(fetchPage: (pageToken?: string) => Promise<{ data: T[]; nextPageToken: string | null }>, onItem: (item: T) => Promise<void>): Promise<void> {
  let pageToken: string | undefined;
  do {
    const { data, nextPageToken } = await fetchPage(pageToken);
    for (const item of data) await onItem(item);
    pageToken = nextPageToken ?? undefined;
  } while (pageToken);
}

function messageEvent(m: QuoMessageObject): NormalizedQuoEvent | null {
  if (!m.id) return null;
  const type = m.direction === "outgoing" ? "message.delivered" : "message.received";
  return parseQuoWebhook({ id: `quo:backfill:msg:${m.id}`, type, createdAt: m.createdAt, data: { object: m } });
}
function callEvent(c: QuoCallObject): NormalizedQuoEvent | null {
  if (!c.id) return null;
  return parseQuoWebhook({ id: `quo:backfill:call:${c.id}`, type: "call.completed", createdAt: c.createdAt, data: { object: c } });
}
function recordingEvent(callId: string, r: QuoRecordingObject): NormalizedQuoEvent | null {
  return parseQuoWebhook({ id: `quo:backfill:rec:${callId}`, type: "call.recording.completed", data: { object: { callId, url: r.url, type: r.type, duration: r.duration, startTime: r.startTime } } });
}
function transcriptEvent(callId: string, t: QuoTranscriptObject): NormalizedQuoEvent | null {
  return parseQuoWebhook({ id: `quo:backfill:tr:${callId}`, type: "call.transcript.completed", data: { object: { callId, dialogue: t.dialogue, text: t.text } } });
}
function summaryEvent(callId: string, s: QuoSummaryObject): NormalizedQuoEvent | null {
  return parseQuoWebhook({ id: `quo:backfill:sum:${callId}`, type: "call.summary.completed", data: { object: { callId, summary: s.summary } } });
}

export async function runBackfill(prisma: PrismaClient, client: QuoClient, opts: BackfillOptions): Promise<BackfillReport> {
  // История + лок одного активного LIVE-запуска.
  let run: { id: string };
  try {
    run = await prisma.quoBackfillRun.create({
      data: {
        mode: opts.mode, status: "RUNNING", fromAt: opts.from, toAt: opts.to,
        siteId: opts.siteId ?? null, quoPhoneNumberId: opts.quoPhoneNumberId ?? null,
        initiatedByUserId: opts.initiatedByUserId ?? null,
        ...(opts.mode === "LIVE" ? { activeLock: "ACTIVE" } : {}),
      },
      select: { id: true },
    });
  } catch (err) {
    if (opts.mode === "LIVE" && P2002(err)) throw new BackfillConcurrentError();
    throw err;
  }

  const counters: BackfillCounters = { found: 0, created: 0, updated: 0, skipped: 0, unlinked: 0, errors: 0 };
  const byType: Record<string, number> = {};
  const bySite: Record<string, number> = {};
  const limiter = opts.limiter ?? createRateLimiter(10);
  const maxResults = opts.maxResults ?? 100;
  const sitesProcessed: string[] = [];

  const tally = (event: NormalizedQuoEvent, siteKey: string, res: { outcome: string; linked: boolean }) => {
    byType[event.kind === "message" ? event.type : event.kind] = (byType[event.kind === "message" ? event.type : event.kind] ?? 0) + 1;
    bySite[siteKey] = (bySite[siteKey] ?? 0) + 1;
    if (res.outcome === "created") { counters.created++; if (!res.linked) counters.unlinked++; }
    else if (res.outcome === "updated" || res.outcome === "enriched") counters.updated++;
    else counters.skipped++; // duplicate | skipped
  };

  async function handleEvent(event: NormalizedQuoEvent | null, siteKey: string): Promise<void> {
    if (!event) { counters.skipped++; return; }
    try {
      if (opts.mode === "DRY_RUN") {
        const p = await planQuoEvent(prisma, event);
        tally(event, siteKey, p);
      } else {
        const r = await ingestQuoEvent(prisma, event);
        const linked = "orderId" in r ? r.orderId != null : false;
        tally(event, siteKey, { outcome: r.outcome, linked });
      }
    } catch (err) {
      if (err instanceof QuoApiError && (err.kind === "auth" || err.kind === "forbidden")) throw err; // останавливает запуск
      counters.errors++;
      quoLog("backfill.event_error", { kind: event.kind, error: safeError(err) });
    }
  }

  try {
    const sites = await prisma.site.findMany({
      where: { quoPhoneNumberId: { not: null }, ...(opts.siteId ? { id: opts.siteId } : {}), ...(opts.quoPhoneNumberId ? { quoPhoneNumberId: opts.quoPhoneNumberId } : {}) },
      select: { id: true, shortName: true, quoPhoneNumberId: true },
    });

    for (const site of sites) {
      sitesProcessed.push(site.shortName);
      const pn = site.quoPhoneNumberId!;
      const participants = await getParticipants(prisma, site.id, opts.from, opts.to, opts.maxParticipantsPerSite ?? 1000);
      for (const participant of participants) {
        // Сообщения.
        await paginate(
          async (pageToken) => { await limiter.acquire(); return client.listMessages({ phoneNumberId: pn, participants: [participant], maxResults, createdAfter: opts.from.toISOString(), pageToken }); },
          async (m) => { counters.found++; await handleEvent(messageEvent(m), site.shortName); }
        );
        // Звонки + обогащение (запись/транскрипт/summary — read-only GET в обоих режимах).
        await paginate(
          async (pageToken) => { await limiter.acquire(); return client.listCalls({ phoneNumberId: pn, participants: [participant], maxResults, createdAfter: opts.from.toISOString(), pageToken }); },
          async (c) => {
            counters.found++;
            await handleEvent(callEvent(c), site.shortName);
            if (!c.id) return;
            await limiter.acquire();
            const recs = await client.getCallRecordings(c.id).catch((e) => { if (e instanceof QuoApiError && (e.kind === "auth" || e.kind === "forbidden")) throw e; return [] as QuoRecordingObject[]; });
            if (recs[0]?.url) await handleEvent(recordingEvent(c.id, recs[0]), site.shortName);
            await limiter.acquire();
            const tr = await client.getCallTranscript(c.id); // null если недоступно (plan-gated)
            if (tr) await handleEvent(transcriptEvent(c.id, tr), site.shortName);
            await limiter.acquire();
            const sum = await client.getCallSummary(c.id);
            if (sum) await handleEvent(summaryEvent(c.id, sum), site.shortName);
          }
        );
      }
    }

    await prisma.quoBackfillRun.update({ where: { id: run.id }, data: { status: "DONE", counters, breakdown: { byType, bySite }, finishedAt: new Date(), activeLock: null } });
    quoLog("backfill.done", { runId: run.id, mode: opts.mode, ...counters });
    return { runId: run.id, mode: opts.mode, counters, breakdown: { byType, bySite }, sites: sitesProcessed };
  } catch (err) {
    await prisma.quoBackfillRun.update({ where: { id: run.id }, data: { status: "FAILED", counters, breakdown: { byType, bySite }, finishedAt: new Date(), activeLock: null, safeError: safeError(err) } }).catch(() => {});
    quoLog("backfill.failed", { runId: run.id, error: safeError(err) });
    throw err;
  }
}
