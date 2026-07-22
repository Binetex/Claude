import "server-only";
/**
 * Адаптер: превращает оркестрацию создания Burq draft в OutboxHandler для worker'а
 * (eventType `burq.draft.create.requested`). Ошибки пробрасываются → outbox повторит с backoff.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import type { OutboxHandler } from "@/outbox/worker";
import type { OutboxRecord } from "@/outbox/types";
import { isBurqRuntimeEnabled } from "@/lib/featureFlags";
import { getBurqRuntimeClient } from "./settings";
import { createPrismaDraftPort } from "./draftPort.prisma";
import { handleBurqDraftCreate } from "./draftHandler";
import type { BurqDraftCreatePayload } from "./schedule";

export function buildBurqDraftCreateHandler(
  prisma: PrismaClient,
  log: (event: string, extra?: Record<string, unknown>) => void = () => {}
): OutboxHandler {
  const port = createPrismaDraftPort(prisma);
  return async (record: OutboxRecord) => {
    if (!isBurqRuntimeEnabled()) {
      log("burq.draft.skipped_runtime_disabled", { id: record.id }); // master gate: no-op, событие помечается processed
      return;
    }
    const payload = record.payload as BurqDraftCreatePayload;
    const client = await getBurqRuntimeClient(); // real из БД-кредов при runtime ON, иначе mock
    await handleBurqDraftCreate({ client, port, log }, payload);
  };
}
