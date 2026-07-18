import { describe, it, expect } from "vitest";
import { buildDeliveryCompletedHandler, type DeliveryNotifyContext } from "./handlers";
import { InMemoryProcessedOperationStore } from "./idempotency";
import { MessagingService } from "@/messaging/service";
import { createMockProviders } from "@/messaging/providers/mock";
import { IntegrationError } from "@/integrations/errors";
import type { OutboxRecord } from "./types";

function record(): OutboxRecord {
  const now = new Date("2026-07-18T00:00:00Z");
  return {
    id: "obx1",
    eventType: "order.delivery.completed",
    aggregateType: "order",
    aggregateId: "o1",
    payload: { orderId: "o1" },
    idempotencyKey: "order.delivery.completed:o1",
    status: "PROCESSING",
    attempts: 1,
    maxAttempts: 8,
    availableAt: now,
    lockedAt: now,
    lockedBy: "W1",
    processedAt: null,
    lastError: null,
    createdAt: now,
    updatedAt: now,
  };
}

const fullCtx: DeliveryNotifyContext = {
  orderNumber: "DEMO-1001",
  senderPhone: "+15551112222",
  senderEmail: "buyer@example.com",
  senderTelegramId: "tg-1",
  senderPushToken: "push-1",
};

function setup(ctx: DeliveryNotifyContext | null) {
  const providers = createMockProviders();
  const messaging = new MessagingService()
    .register(providers.SMS)
    .register(providers.EMAIL)
    .register(providers.TELEGRAM)
    .register(providers.PUSH);
  const idempotency = new InMemoryProcessedOperationStore();
  let syncCalls = 0;
  const handler = buildDeliveryCompletedHandler({
    messaging,
    idempotency,
    resolve: async () => ctx,
    completionSync: async () => { syncCalls++; },
  });
  return { providers, handler, idempotency, getSyncCalls: () => syncCalls };
}

describe("delivery.completed — независимый фан-аут во все каналы", () => {
  it("отправляет SMS/Telegram/email/push и запускает completion-sync", async () => {
    const { providers, handler, getSyncCalls } = setup(fullCtx);
    await handler(record());
    expect(providers.SMS.sent).toHaveLength(1);
    expect(providers.TELEGRAM.sent).toHaveLength(1);
    expect(providers.EMAIL.sent).toHaveLength(1);
    expect(providers.PUSH.sent).toHaveLength(1);
    expect(getSyncCalls()).toBe(1);
  });

  it("шлёт только по доступным контактам", async () => {
    const { providers, handler } = setup({ ...fullCtx, senderEmail: null, senderPushToken: null, senderTelegramId: null });
    await handler(record());
    expect(providers.SMS.sent).toHaveLength(1);
    expect(providers.EMAIL.sent).toHaveLength(0);
    expect(providers.TELEGRAM.sent).toHaveLength(0);
    expect(providers.PUSH.sent).toHaveLength(0);
  });
});

describe("delivery.completed — изоляция сбоев и идемпотентность", () => {
  it("сбой Telegram НЕ блокирует SMS/email/sync; handler бросает retryable", async () => {
    const { providers, handler, getSyncCalls } = setup(fullCtx);
    providers.TELEGRAM.failWith = new IntegrationError("tg down", { kind: "retryable", platform: "telegram" });

    await expect(handler(record())).rejects.toBeInstanceOf(IntegrationError);
    // Остальные каналы всё равно отправлены (независимость).
    expect(providers.SMS.sent).toHaveLength(1);
    expect(providers.EMAIL.sent).toHaveLength(1);
    expect(providers.PUSH.sent).toHaveLength(1);
    expect(getSyncCalls()).toBe(1);
    expect(providers.TELEGRAM.sent).toHaveLength(0);
  });

  it("повторная доставка события не отправляет вторую SMS (idempotency)", async () => {
    const { providers, handler } = setup(fullCtx);
    await handler(record());
    await handler(record()); // повтор того же события
    expect(providers.SMS.sent).toHaveLength(1);
    expect(providers.EMAIL.sent).toHaveLength(1);
  });

  it("при повторе повторяется ТОЛЬКО ранее упавший канал", async () => {
    const { providers, handler } = setup(fullCtx);
    providers.TELEGRAM.failWith = new IntegrationError("tg down", { kind: "retryable", platform: "telegram" });
    await expect(handler(record())).rejects.toBeInstanceOf(IntegrationError);
    expect(providers.SMS.sent).toHaveLength(1);

    // Чиним Telegram и повторяем (как это сделал бы worker после backoff).
    providers.TELEGRAM.failWith = undefined;
    await handler(record());

    expect(providers.SMS.sent).toHaveLength(1); // SMS НЕ переотправлена
    expect(providers.TELEGRAM.sent).toHaveLength(1); // Telegram доставлен на повторе
  });

  it("нет контекста заказа — ничего не шлёт, не падает", async () => {
    const { providers, handler, getSyncCalls } = setup(null);
    await expect(handler(record())).resolves.toBeUndefined();
    expect(providers.SMS.sent).toHaveLength(0);
    expect(getSyncCalls()).toBe(0);
  });
});
