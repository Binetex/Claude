/**
 * Универсальная инфраструктура уведомлений. Единый контракт для всех каналов
 * (SMS/Telegram/email/push) — бизнес-код формирует `MessageCommand`, а конкретный провайдер
 * (Quo/Telegram/SMTP/WebPush) скрыт за `MessageProvider`. Провайдеры не зашиваются в
 * webhook-хендлеры — доставка идёт через сервис/подписчиков событий.
 */
import type { MessageChannel } from "@/integrations/normalized";

export type { MessageChannel };

/** Идентификатор шаблона сообщения (см. templates.ts). */
export type MessageTemplateId =
  | "florist.order.assigned"
  | "order.ready"
  | "order.delivery.completed"
  | "order.delivery.started";

/** Команда на отправку одного сообщения. Идемпотентна по `idempotencyKey`. */
export type MessageCommand = {
  channel: MessageChannel;
  /** Адресат: телефон / email / telegramId / push-subscription id. */
  to: string;
  templateId: MessageTemplateId;
  vars: Record<string, string | number>;
  idempotencyKey: string;
};

/** Итог операции отправки (наш уровень). */
export type MessageDeliveryStatus = "sent" | "skipped" | "failed";

/** Состояние доставки у провайдера (обновляется вебхуками провайдера позже). */
export type ProviderDeliveryState = "queued" | "sent" | "delivered" | "failed";

export type MessageResult = {
  status: MessageDeliveryStatus;
  channel: MessageChannel;
  /** id сообщения во внешней системе провайдера (если отправлено). Канонический идентификатор. */
  externalMessageId?: string;
  /** @deprecated используйте `externalMessageId` — оставлено для обратной совместимости. */
  providerId?: string;
  /** Состояние доставки у провайдера (queued/sent/delivered/failed). */
  deliveryStatus?: ProviderDeliveryState;
  /** Причина skipped/failed. */
  reason?: string;
  /** Для failed: можно ли повторить (классификация из IntegrationError). */
  retryable?: boolean;
};

/** Отрендеренное сообщение, готовое к отправке провайдером. */
export type RenderedMessage = {
  channel: MessageChannel;
  to: string;
  subject: string | null; // релевантно для email
  body: string;
};

/**
 * Провайдер одного канала. Реальные (Quo/Telegram/SMTP/WebPush) реализуют этот интерфейс;
 * ночью используются mock-провайдеры без сетевых вызовов.
 */
export interface MessageProvider {
  channel: MessageChannel;
  send(
    message: RenderedMessage,
    command: MessageCommand
  ): Promise<{ providerId: string; deliveryStatus?: ProviderDeliveryState }>;
}
