import { expect } from "vitest";
import type { MessageProvider, RenderedMessage, MessageCommand } from "../types";

/**
 * Общая контракт-сюита для `MessageProvider`. Любая реализация (mock/Quo/Telegram/SMTP/WebPush)
 * должна её проходить — так каналы остаются взаимозаменяемыми за единым интерфейсом.
 */
export async function assertMessageProviderContract(provider: MessageProvider, to: string): Promise<void> {
  const message: RenderedMessage = {
    channel: provider.channel,
    to,
    subject: provider.channel === "EMAIL" ? "Тема" : null,
    body: "Тело сообщения",
  };
  const command: MessageCommand = {
    channel: provider.channel,
    to,
    templateId: "order.delivery.completed",
    vars: { orderNumber: "DEMO-1" },
    idempotencyKey: `contract:${provider.channel}`,
  };

  const result = await provider.send(message, command);

  // Возвращает непустой externalMessageId (id у провайдера).
  expect(typeof result.providerId).toBe("string");
  expect(result.providerId.length).toBeGreaterThan(0);
  // deliveryStatus (если задан) — из допустимого множества.
  if (result.deliveryStatus !== undefined) {
    expect(["queued", "sent", "delivered", "failed"]).toContain(result.deliveryStatus);
  }
  // Канал провайдера согласован.
  expect(provider.channel).toBe(message.channel);
}
