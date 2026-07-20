import "server-only";
/**
 * Outbox-handler `quo.webhook.received`: обрабатывает уже проверенное (подпись) и durable-сохранённое
 * (PENDING в outbox) нормализованное событие QUO. Ошибка обработки → throw → outbox повторит с backoff
 * (не теряем событие). Ретраибельные случаи (обогащение раньше call.completed) — QuoIngestRetryableError.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import type { OutboxHandler } from "@/outbox/worker";
import type { OutboxRecord } from "@/outbox/types";
import { ingestQuoEvent, type QuoIngestDeps } from "./ingest";
import { getQuoConfig } from "./config";
import { createQuoClient } from "./client";
import type { NormalizedQuoEvent } from "./types";

export const QUO_WEBHOOK_EVENT = "quo.webhook.received";

export function buildQuoWebhookHandler(prisma: PrismaClient): OutboxHandler {
  // Клиент строим один раз. Нужен, чтобы догрузить URL записи, если webhook пришёл без него.
  const cfg = getQuoConfig();
  const client = cfg ? createQuoClient(cfg) : null;
  const deps: QuoIngestDeps = client
    ? {
        fetchRecording: async (callId) => {
          const recs = await client.getCallRecordings(callId);
          const r = recs?.[0];
          return r ? { url: r.url ?? null, duration: typeof r.duration === "number" ? r.duration : null } : null;
        },
      }
    : {};
  return async (record: OutboxRecord) => {
    await ingestQuoEvent(prisma, record.payload as NormalizedQuoEvent, deps);
  };
}
