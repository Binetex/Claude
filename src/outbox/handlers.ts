/**
 * Handlers доменных событий для outbox-worker'а. Каждый handler идемпотентен по операциям
 * (runOnce + ProcessedOperationStore) — повторная доставка события не вызывает повторное
 * побочное действие (второй SMS/Telegram, повторный fulfillment/Burq и т.п.).
 *
 * `order.delivery.completed` фан-аутит в каналы + completion-sync НЕЗАВИСИМО: сбой Telegram
 * не мешает SMS/email/push/Shopify. Если хотя бы одна операция упала ретраябельно — handler
 * бросает ретраябельную ошибку, worker перепланирует событие; при повторе уже успешные
 * операции пропускаются (guard), повторяется только упавшая.
 *
 * Чистый модуль (без server-only): зависимости инъектируются → тестируется без БД.
 */
import { IntegrationError } from "@/integrations/errors";
import { runOnce, type ProcessedOperationStore } from "./idempotency";
import type { MessagingService } from "@/messaging/service";
import type { MessageChannel } from "@/messaging/types";
import type { OutboxHandler } from "./worker";
import type { OutboxRecord } from "./types";

export type DeliveryNotifyContext = {
  orderNumber: string;
  senderPhone: string | null;
  senderEmail: string | null;
  senderTelegramId: string | null;
  senderPushToken: string | null;
};

export type DeliveryHandlerDeps = {
  messaging: MessagingService;
  idempotency: ProcessedOperationStore;
  resolve: (orderId: string) => Promise<DeliveryNotifyContext | null>;
  /** Completion-sync во внешнюю платформу (Shopify/Woo fulfillment). Идемпотентен через guard. */
  completionSync?: (orderId: string) => Promise<void>;
};

type Task = { key: string; kind: string; run: () => Promise<string | null> };

function channelTask(
  deps: DeliveryHandlerDeps,
  channel: MessageChannel,
  to: string,
  key: string,
  kind: string,
  orderNumber: string
): Task {
  return {
    key,
    kind,
    run: async () => {
      const res = await deps.messaging.send({
        channel,
        to,
        templateId: "order.delivery.completed",
        vars: { orderNumber },
        idempotencyKey: key,
      });
      if (res.status === "failed") {
        throw new IntegrationError(res.reason ?? "send failed", {
          kind: res.retryable ? "retryable" : "permanent",
          platform: channel,
        });
      }
      return res.providerId ?? null;
    },
  };
}

export function buildDeliveryCompletedHandler(deps: DeliveryHandlerDeps): OutboxHandler {
  return async (record: OutboxRecord) => {
    const { orderId } = (record.payload ?? {}) as { orderId?: string };
    if (!orderId) return; // некорректный payload — нечего делать (PROCESSED)

    const ctx = await deps.resolve(orderId);
    if (!ctx) return; // заказ/контакты не найдены — нечего отправлять

    const idem = record.idempotencyKey;
    const tasks: Task[] = [];
    if (ctx.senderPhone) tasks.push(channelTask(deps, "SMS", ctx.senderPhone, `${idem}:sms`, "sms.send", ctx.orderNumber));
    if (ctx.senderTelegramId) tasks.push(channelTask(deps, "TELEGRAM", ctx.senderTelegramId, `${idem}:tg`, "telegram.send", ctx.orderNumber));
    if (ctx.senderEmail) tasks.push(channelTask(deps, "EMAIL", ctx.senderEmail, `${idem}:email`, "email.send", ctx.orderNumber));
    if (ctx.senderPushToken) tasks.push(channelTask(deps, "PUSH", ctx.senderPushToken, `${idem}:push`, "push.send", ctx.orderNumber));
    if (deps.completionSync) {
      tasks.push({
        key: `${idem}:completion_sync`,
        kind: "platform.completion_sync",
        run: async () => {
          await deps.completionSync!(orderId);
          return null;
        },
      });
    }

    // Все операции — НЕЗАВИСИМО (одна упавшая не мешает остальным), каждая под guard'ом.
    const results = await Promise.allSettled(
      tasks.map((t) => runOnce(deps.idempotency, { key: t.key, kind: t.kind, extractExternalId: (v) => v }, t.run))
    );

    const failures = results
      .filter((r): r is PromiseRejectedResult => r.status === "rejected")
      .map((r) => r.reason);

    if (failures.length > 0) {
      const anyRetryable = failures.some((e) => e instanceof IntegrationError && e.isRetryable);
      // Ретраябельно, если хоть одна операция ретраябельна → worker перепланирует; успешные
      // операции при повторе пропустит guard. Иначе — окончательно (перейдёт в dead-letter).
      throw new IntegrationError(`${failures.length}/${tasks.length} downstream операций упало`, {
        kind: anyRetryable ? "retryable" : "permanent",
        platform: "outbox.delivery.completed",
      });
    }
  };
}
