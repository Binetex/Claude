/**
 * Сервис уведомлений: маршрутизирует `MessageCommand` в провайдер нужного канала,
 * рендерит шаблон, обеспечивает идемпотентность (дедуп по `idempotencyKey`) и
 * классифицирует ошибки для повторов. Провайдеры регистрируются по каналу — реальные
 * или mock. Единая точка, через которую бизнес-код отправляет сообщения.
 */
import { renderMessage } from "./templates";
import type { MessageChannel, MessageCommand, MessageProvider, MessageResult } from "./types";
import { IntegrationError } from "@/integrations/errors";

export class MessagingService {
  private providers = new Map<MessageChannel, MessageProvider>();
  private seen = new Set<string>();

  register(provider: MessageProvider): this {
    this.providers.set(provider.channel, provider);
    return this;
  }

  /** Отправляет одно сообщение. Идемпотентно: повтор того же ключа → status "skipped". */
  async send(command: MessageCommand): Promise<MessageResult> {
    if (this.seen.has(command.idempotencyKey)) {
      return { status: "skipped", channel: command.channel, reason: "duplicate" };
    }

    const provider = this.providers.get(command.channel);
    if (!provider) {
      return { status: "skipped", channel: command.channel, reason: "no_provider" };
    }

    let rendered;
    try {
      rendered = renderMessage(command.templateId, command.channel, command.to, command.vars);
    } catch (err) {
      return { status: "failed", channel: command.channel, reason: err instanceof Error ? err.message : "render_error", retryable: false };
    }

    try {
      const { providerId } = await provider.send(rendered, command);
      this.seen.add(command.idempotencyKey); // фиксируем успех — повтор не отправит дубль
      return { status: "sent", channel: command.channel, providerId };
    } catch (err) {
      const retryable = err instanceof IntegrationError ? err.isRetryable : false;
      return { status: "failed", channel: command.channel, reason: err instanceof Error ? err.message : "send_error", retryable };
    }
  }

  /** Рассылает одно уведомление в несколько каналов (best-effort, независимо). */
  async sendMany(commands: MessageCommand[]): Promise<MessageResult[]> {
    return Promise.all(commands.map((c) => this.send(c)));
  }

  reset(): void {
    this.seen.clear();
  }
}
