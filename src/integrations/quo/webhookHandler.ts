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
import { publishAssistantIncoming } from "@/modules/assistant/events";
import { PrismaOutboxRepository } from "@/outbox/prismaRepository";
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
    const res = await ingestQuoEvent(prisma, record.payload as NormalizedQuoEvent, deps);
    // Новое входящее — повод посмотреть, должен ли ответить ассистент. Отдельным событием:
    // разбор ходит в модель, а приём входящих обязан оставаться быстрым.
    if (res.outcome === "created" && (record.payload as NormalizedQuoEvent).direction === "INBOUND") {
      await publishAssistantIncoming(new PrismaOutboxRepository(prisma), res.communicationId);
    }
    // Расшифровка звонка приходит отдельным событием и позже самого звонка: для ассистента это
    // и есть «клиент что-то сказал». Свой ключ, иначе дедуп по входящему её проглотит.
    if (res.outcome === "enriched" && (res.kind === "transcript" || res.kind === "summary")) {
      const repo = new PrismaOutboxRepository(prisma);
      for (const id of res.communicationIds) await publishAssistantIncoming(repo, id, `${res.kind}`);
    }
  };
}
