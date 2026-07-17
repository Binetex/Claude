/**
 * Шаблоны сообщений. Отделены от провайдеров и каналов: один шаблон может рендериться
 * в SMS/Telegram/email/push. Рендер — чистая функция подстановки `{var}`. Тексты —
 * черновые (ночь); финальные формулировки согласует владелец (блокер в отчёте).
 */
import type { MessageChannel, MessageTemplateId, RenderedMessage } from "./types";

type TemplateDef = {
  subject?: (vars: Vars) => string;
  body: (vars: Vars) => string;
};

type Vars = Record<string, string | number>;

const TEMPLATES: Record<MessageTemplateId, TemplateDef> = {
  "florist.order.assigned": {
    subject: () => "Новый заказ назначен",
    body: (v) => `Вам назначен заказ ${v.orderNumber}. Доставка: ${v.deliveryDate ?? "—"} ${v.deliveryWindow ?? ""}.`.trim(),
  },
  "order.ready": {
    subject: (v) => `Заказ ${v.orderNumber} готов`,
    body: (v) => `Заказ ${v.orderNumber} готов к выдаче/отправке.`,
  },
  "order.delivery.started": {
    subject: (v) => `Заказ ${v.orderNumber} в пути`,
    body: (v) => `Ваш заказ ${v.orderNumber} передан в доставку.${v.trackingUrl ? ` Отслеживание: ${v.trackingUrl}` : ""}`,
  },
  "order.delivery.completed": {
    subject: (v) => `Заказ ${v.orderNumber} доставлен`,
    body: (v) => `Ваш заказ ${v.orderNumber} доставлен. Спасибо, что выбрали нас!`,
  },
};

/** Рендерит шаблон в сообщение канала. subject заполняется только для email. */
export function renderMessage(
  templateId: MessageTemplateId,
  channel: MessageChannel,
  to: string,
  vars: Vars
): RenderedMessage {
  const def = TEMPLATES[templateId];
  if (!def) throw new Error(`Неизвестный шаблон сообщения: ${templateId}`);
  return {
    channel,
    to,
    subject: channel === "EMAIL" && def.subject ? def.subject(vars) : null,
    body: def.body(vars),
  };
}

export function templateExists(id: string): id is MessageTemplateId {
  return id in TEMPLATES;
}
