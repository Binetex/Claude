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
 * Вкладки блока общения. Порядок: Получатель слева, Заказчик справа; при совпадающих
 * номерах — одна вкладка. `target` — куда уйдёт SMS; `null` означает, что отправка отсюда
 * невозможна (вкладка «Другой номер»).
 */
export type CommTabKey = "RECIPIENT" | "CUSTOMER" | "SAME";

export type CommTab = {
  key: CommTabKey;
  label: string;
  phone: string;
  target: "CUSTOMER" | "RECIPIENT";
};

const last10 = (p: string | null | undefined): string => (p ?? "").replace(/\D/g, "").slice(-10);

/** Что нужно знать о сообщении, чтобы положить его во вкладку. */
export type CommForGrouping = {
  externalPhone: string;
  /** Роль, проставленная при приёме. Используется, только если номера нет вовсе. */
  partyRole: "CUSTOMER" | "RECIPIENT" | "UNKNOWN";
};

/**
 * В какую вкладку попадает сообщение. Сторон ровно две — получатель и заказчик; третьей
 * группы нет, каждое сообщение видно под одной из них.
 *
 * РЕШАЕТ ФАКТИЧЕСКИЙ НОМЕР. Сохранённая роль проставляется один раз, при приёме, и потом
 * устаревает: у заказа PAR-41318 телефоны заказчика и получателя сперва совпадали,
 * сопоставитель выбрал CUSTOMER наугад, а когда телефон заказчика исправили на настоящий,
 * вся переписка с получателем осталась висеть во вкладке «Заказчик» — с номером, на который
 * никто никогда не писал. Ответ из этой вкладки ушёл бы не тому человеку.
 *
 * Роль остаётся запасным вариантом: номера нет или он не совпал ни с одной стороной. Это
 * не хуже прежнего поведения — раньше роль решала всегда, — и ничего не прячет.
 */
export function commGroupOf(c: CommForGrouping, customerPhone: string, recipientPhone: string): CommTabKey {
  const cust = last10(customerPhone);
  const recip = last10(recipientPhone);
  if (cust && cust === recip) return "SAME"; // одна вкладка на оба номера

  const phone = last10(c.externalPhone);
  if (phone && phone === recip) return "RECIPIENT";
  if (phone && phone === cust) return "CUSTOMER";
  // Номер ничего не сказал — верим тому, что записал приём.
  return c.partyRole === "RECIPIENT" ? "RECIPIENT" : "CUSTOMER";
}

/** Вкладки блока: две стороны заказа, либо одна при совпадающих номерах. */
export function buildCommTabs(customerPhone: string, recipientPhone: string): CommTab[] {
  const cust = last10(customerPhone);
  const recip = last10(recipientPhone);
  if (cust && cust === recip) {
    return [{ key: "SAME", label: "Заказчик", phone: customerPhone || recipientPhone, target: "CUSTOMER" }];
  }
  return [
    { key: "RECIPIENT", label: "Получатель", phone: recipientPhone, target: "RECIPIENT" },
    { key: "CUSTOMER", label: "Заказчик", phone: customerPhone, target: "CUSTOMER" },
  ];
}

export type Timelineable = { occurredAt: Date | string };
/** Единый порядок ленты: новые сверху (desc). */
export function sortTimelineDesc<T extends Timelineable>(items: T[]): T[] {
  return [...items].sort((a, b) => new Date(toIso(b.occurredAt)).getTime() - new Date(toIso(a.occurredAt)).getTime());
}
