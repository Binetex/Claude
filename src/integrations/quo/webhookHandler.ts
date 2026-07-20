import "server-only";
/**
 * Outbox-handler `quo.webhook.received`: обрабатывает уже проверенное (подпись) и durable-сохранённое
 * (PENDING в outbox) нормализованное событие QUO. Ошибка обработки → throw → outbox повторит с backoff
 * (не теряем событие). Ретраибельные случаи (обогащение раньше call.completed) — QuoIngestRetryableError.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import type { OutboxHandler } from "@/outbox/worker";
import type { OutboxRecord } from "@/outbox/types";
import { ingestQuoEvent } from "./ingest";
import type { NormalizedQuoEvent } from "./types";

export const QUO_WEBHOOK_EVENT = "quo.webhook.received";

export function buildQuoWebhookHandler(prisma: PrismaClient): OutboxHandler {
  return async (record: OutboxRecord) => {
    await ingestQuoEvent(prisma, record.payload as NormalizedQuoEvent);
  };
}
