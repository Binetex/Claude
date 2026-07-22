/**
 * Абстракция канала доставки автоматизаций. SMS — первая реализация; EMAIL/PUSH/WEBHOOK/…
 * добавляются регистрацией нового ChannelSender БЕЗ изменения модели Automation и движка.
 *
 * Контракт намеренно узкий: движок рендерит текст и решает «кому/что», а канал — «как отправить»
 * и как это отразить (communicationId/providerMessageId). Реальная интеграция (для SMS — QUO)
 * инкапсулирована внутри реализации, а не в движке.
 */
import type { PrismaClient } from "@/generated/prisma/client";

export type ChannelSendContext = {
  prisma: PrismaClient;
  orderId: string;
  siteId: string;
  recipientType: "CUSTOMER" | "RECIPIENT";
  phoneNormalized: string; // адресат (для SMS/телефонных каналов)
  text: string; // уже отрендеренный текст
  /** Ключ идемпотентности отправки (движок формирует его per-attempt). */
  idempotencyKey: string;
};

export type ChannelSendResult =
  | { ok: true; communicationId?: string | null; providerMessageId?: string | null }
  // skip=true → это precondition/config-проблема (не отправляем, job SKIPPED), а не сбой (FAILED).
  | { ok: false; code: string; retryable: boolean; skip?: boolean };

export interface ChannelSender {
  /** Значение AutomationChannel, которое обслуживает эта реализация. */
  readonly channel: string;
  send(ctx: ChannelSendContext): Promise<ChannelSendResult>;
}
