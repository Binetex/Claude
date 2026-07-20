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

export type Timelineable = { occurredAt: Date | string };
/** Единый порядок ленты: новые сверху (desc). */
export function sortTimelineDesc<T extends Timelineable>(items: T[]): T[] {
  return [...items].sort((a, b) => new Date(toIso(b.occurredAt)).getTime() - new Date(toIso(a.occurredAt)).getTime());
}
