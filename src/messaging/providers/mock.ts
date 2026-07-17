/**
 * Mock-провайдеры сообщений для всех каналов. Ничего не отправляют по сети — записывают
 * «отправленные» сообщения в память. Используются в тестах и как безопасная реализация
 * ночью (Quo/Telegram — skeleton без production-вызовов). Реальные провайдеры заменят
 * их за тем же интерфейсом `MessageProvider`.
 */
import type { MessageChannel, MessageProvider, RenderedMessage, MessageCommand } from "../types";

export type SentRecord = { message: RenderedMessage; command: MessageCommand; providerId: string };

export class MockMessageProvider implements MessageProvider {
  readonly channel: MessageChannel;
  readonly sent: SentRecord[] = [];
  private seq = 0;
  /** Если задано — `send` бросает эту ошибку (для тестов сбоев/повторов). */
  failWith?: Error;

  constructor(channel: MessageChannel) {
    this.channel = channel;
  }

  async send(message: RenderedMessage, command: MessageCommand): Promise<{ providerId: string }> {
    if (this.failWith) throw this.failWith;
    const providerId = `mock-${this.channel.toLowerCase()}-${++this.seq}`;
    this.sent.push({ message, command, providerId });
    return { providerId };
  }
}

/** Набор mock-провайдеров на все каналы. */
export function createMockProviders(): Record<MessageChannel, MockMessageProvider> {
  return {
    SMS: new MockMessageProvider("SMS"),
    EMAIL: new MockMessageProvider("EMAIL"),
    TELEGRAM: new MockMessageProvider("TELEGRAM"),
    PUSH: new MockMessageProvider("PUSH"),
  };
}
