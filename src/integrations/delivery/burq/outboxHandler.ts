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
import { handleCourierPrecheck, type BurqCourierCheckPayload } from "./precheck";

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

/**
 * Предварительная проверка курьеров (`burq.courier.check.requested`).
 *
 * Ошибку НЕ пробрасываем: проверка — вспомогательная, и её повтор не должен занимать очередь
 * при недоступном Burq. Не получилось — осталось «не проверяли», следующая смена данных
 * поставит задачу заново.
 */
export function buildBurqCourierCheckHandler(
  prisma: PrismaClient,
  log: (event: string, extra?: Record<string, unknown>) => void = () => {}
): OutboxHandler {
  const port = createPrismaDraftPort(prisma);
  return async (record: OutboxRecord) => {
    if (!isBurqRuntimeEnabled()) {
      log("burq.couriers.precheck_skipped_runtime_disabled", { id: record.id });
      return;
    }
    const payload = record.payload as BurqCourierCheckPayload;
    try {
      const client = await getBurqRuntimeClient();
      await handleCourierPrecheck({ client, port, log }, payload);
    } catch (err) {
      log("burq.couriers.precheck_failed", { id: record.id, error: err instanceof Error ? err.message : String(err) });
    }
  };
}
