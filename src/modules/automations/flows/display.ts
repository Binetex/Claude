import { pluralRu } from "@/lib/plural";
/**
 * Подписи цепочек для UI. Чистый модуль (без server-only) — используется и серверными
 * страницами, и клиентским редактором, чтобы шаг назывался одинаково везде.
 */
import type { FlowStepTypeInput, FlowWaitUnit } from "./validation";

export const FLOW_STEP_TYPE_LABELS: Record<FlowStepTypeInput, string> = {
  WAIT: "Ожидание",
  EMAIL: "Email",
  SMS: "SMS",
};

const WAIT_UNIT_LABELS: Record<FlowWaitUnit, [string, string, string]> = {
  // [1, 2-4, 5+] — русские формы числительных
  MINUTE: ["минута", "минуты", "минут"],
  HOUR: ["час", "часа", "часов"],
  DAY: ["день", "дня", "дней"],
};


export function waitLabel(amount: number | null, unit: string | null): string {
  if (!amount || !unit || !(unit in WAIT_UNIT_LABELS)) return "—";
  return `${amount} ${pluralRu(amount, ...WAIT_UNIT_LABELS[unit as FlowWaitUnit])}`;
}

/** Однострочное описание шага для списков и истории. */
export function flowStepSummary(step: {
  type: string;
  waitAmount?: number | null;
  waitUnit?: string | null;
  brevoTemplateId?: number | null;
  template?: string | null;
}): string {
  if (step.type === "WAIT") return `Ждать ${waitLabel(step.waitAmount ?? null, step.waitUnit ?? null)}`;
  if (step.type === "EMAIL") return step.brevoTemplateId ? `Письмо · шаблон #${step.brevoTemplateId}` : "Письмо · шаблон не задан";
  const text = (step.template ?? "").trim();
  return text ? `SMS · ${text.length > 60 ? `${text.slice(0, 60)}…` : text}` : "SMS · текст не задан";
}

export const FLOW_RUN_STATUS_LABELS: Record<string, string> = {
  ACTIVE: "Выполняется",
  COMPLETED: "Завершена",
  CANCELLED: "Остановлена",
};

export const FLOW_STEP_STATUS_LABELS: Record<string, string> = {
  SCHEDULED: "Запланирован",
  PROCESSING: "В работе",
  SENT: "Выполнен",
  SKIPPED: "Пропущен",
  FAILED: "Ошибка",
  CANCELLED: "Отменён",
};

/** Причины остановки run'а — человеческим языком (значения пишет движок). */
export const FLOW_CANCEL_REASON_LABELS: Record<string, string> = {
  flow_disabled: "цепочка выключена",
  flow_deleted: "цепочка удалена",
  site_unlinked: "магазин отвязан от цепочки",
  order_cancelled: "заказ отменён или возвращён",
  order_marketing_muted: "заказ исключён из рассылок",
};
