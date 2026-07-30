/**
 * Провайдер транзакционных писем. Абстракция нужна, чтобы движок автоматизаций (этап 2) не знал
 * про Brevo: он передаёт «кому, по какому шаблону, с какими переменными», а реализация решает,
 * как это отправить.
 *
 * Ошибки намеренно разделены на три вида — так же, как в SMS-канале:
 *  - configuration: отправлять НЕЛЬЗЯ (нет ключа, магазин не настроен) → пропуск, не сбой;
 *  - retryable: временная проблема провайдера → повтор с backoff;
 *  - остальное: окончательный отказ (например, Brevo отверг адрес).
 */
export type EmailSendParams = {
  to: string;
  toName?: string | null;
  brevoTemplateId: number;
  /** Переменные шаблона Brevo ({{ params.order_number }} и т.д.). */
  params: Record<string, string>;
  sender: { email: string; name?: string | null; brevoSenderId?: string | null };
  replyTo?: string | null;
};

export type EmailSendResult =
  | { ok: true; providerMessageId: string | null }
  | {
      ok: false;
      /** Стабильный код для истории и тестов, без текста провайдера. */
      code: string;
      /** Безопасное описание — без ключей и адресов. */
      safeError: string;
      retryable: boolean;
      /** true → это проблема конфигурации, а не сбой отправки. */
      configuration?: boolean;
    };

export interface EmailProvider {
  readonly name: string;
  sendTemplate(params: EmailSendParams): Promise<EmailSendResult>;
}
