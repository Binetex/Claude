/**
 * Чистые view-хелперы истории коммуникаций (без БД/сервера) — тестируются напрямую.
 * Правило непрочитанного, агрегаты для списка заказов, сворачивание длинного текста, порядок ленты.
 */
export type CommForUnread = {
  type: "SMS" | "CALL" | "VOICEMAIL";
  direction: "INBOUND" | "OUTBOUND";
  status: string;
  readAt: Date | string | null;
};

/** Непрочитанным считаем ВХОДЯЩЕЕ SMS и ПРОПУЩЕННЫЙ звонок, если ещё не отмечено прочитанным. */
export function isUnreadComm(c: CommForUnread): boolean {
  if (c.readAt) return false;
  const inboundSms = c.type === "SMS" && c.direction === "INBOUND";
  const missedCall = (c.type === "CALL" || c.type === "VOICEMAIL") && c.status === "MISSED";
  return inboundSms || missedCall;
}

export type CommForIndicator = {
  orderId: string | null;
  type: "SMS" | "CALL" | "VOICEMAIL";
  direction: "INBOUND" | "OUTBOUND";
  status: string;
  readAt: Date | string | null;
  occurredAt: Date | string;
  messageText: string | null;
};

export type OrderIndicator = {
  unreadInbound: number; // кол-во непрочитанных входящих SMS
  hasMissedUnread: boolean; // есть непрочитанный пропущенный звонок
  lastAt: string | null; // время последней коммуникации (ISO)
  preview: string | null; // короткий preview последнего сообщения
};

function toIso(d: Date | string): string {
  return typeof d === "string" ? d : d.toISOString();
}

/** Сводка индикаторов по каждому заказу из плоского списка коммуникаций (для списка заказов). */
export function computeIndicators(comms: CommForIndicator[]): Record<string, OrderIndicator> {
  const out: Record<string, OrderIndicator> = {};
  // Новейшие первыми — чтобы preview/lastAt брать у самого свежего.
  const sorted = [...comms].sort((a, b) => new Date(toIso(b.occurredAt)).getTime() - new Date(toIso(a.occurredAt)).getTime());
  for (const c of sorted) {
    if (!c.orderId) continue;
    const cur = (out[c.orderId] ??= { unreadInbound: 0, hasMissedUnread: false, lastAt: null, preview: null });
    if (cur.lastAt === null) {
      cur.lastAt = toIso(c.occurredAt);
      if (c.messageText) cur.preview = c.messageText.length > 40 ? c.messageText.slice(0, 40) + "…" : c.messageText;
    }
    if (c.type === "SMS" && c.direction === "INBOUND" && !c.readAt) cur.unreadInbound += 1;
    if ((c.type === "CALL" || c.type === "VOICEMAIL") && c.status === "MISSED" && !c.readAt) cur.hasMissedUnread = true;
  }
  return out;
}

/** Порог сворачивания длинного текста (SMS/транскрипт). */
export const COLLAPSE_THRESHOLD = 300;
export function isLongText(text: string | null | undefined, threshold = COLLAPSE_THRESHOLD): boolean {
  return !!text && text.length > threshold;
}

/**
 * Вкладки блока общения по стороне заказа. Порядок: Получатель первым (слева), Заказчик справа.
 * Если номер заказчика и получателя совпадает — одна вкладка «Клиент» (без дублей). `role` — по чему
 * фильтровать историю (null = показать все, для совпадающего номера). `target` — куда слать SMS.
 */
export type CommTab = {
  key: "RECIPIENT" | "CUSTOMER" | "SAME";
  label: string;
  phone: string;
  target: "CUSTOMER" | "RECIPIENT";
  role: "CUSTOMER" | "RECIPIENT" | null;
};

const last10 = (p: string | null | undefined): string => (p ?? "").replace(/\D/g, "").slice(-10);

export function buildCommTabs(customerPhone: string, recipientPhone: string): CommTab[] {
  const cust = last10(customerPhone);
  const recip = last10(recipientPhone);
  if (cust && cust === recip) {
    return [{ key: "SAME", label: "Клиент", phone: recipientPhone || customerPhone, target: "RECIPIENT", role: null }];
  }
  return [
    { key: "RECIPIENT", label: "Получатель", phone: recipientPhone, target: "RECIPIENT", role: "RECIPIENT" },
    { key: "CUSTOMER", label: "Заказчик", phone: customerPhone, target: "CUSTOMER", role: "CUSTOMER" },
  ];
}

export type Timelineable = { occurredAt: Date | string };
/** Единый порядок ленты: новые сверху (desc). */
export function sortTimelineDesc<T extends Timelineable>(items: T[]): T[] {
  return [...items].sort((a, b) => new Date(toIso(b.occurredAt)).getTime() - new Date(toIso(a.occurredAt)).getTime());
}
