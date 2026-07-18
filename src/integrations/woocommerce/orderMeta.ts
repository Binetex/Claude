/**
 * Конфигурируемое сопоставление полей заказа WooCommerce (§12). Владелец задаёт per-Site
 * mapping «внутреннее поле Floremart → Woo meta key». Ничего не хардкодим: если mapping не
 * задан, поле остаётся пустым (или берётся дефолтная regex-эвристика в parseWooOrder).
 * Чистые функции, без сети/БД.
 */
export type WooMeta = { key?: string; value?: unknown };

/** Внутренние поля Floremart, которые можно вытащить из order meta. */
export type OrderMetaMapping = {
  deliveryDate?: string;
  deliveryWindow?: string;
  recipientName?: string;
  recipientPhone?: string;
  apartment?: string;
  cardMessage?: string;
  deliveryInstructions?: string;
  occasion?: string;
  senderName?: string;
};

export const ORDER_META_FIELDS: (keyof OrderMetaMapping)[] = [
  "deliveryDate",
  "deliveryWindow",
  "recipientName",
  "recipientPhone",
  "apartment",
  "cardMessage",
  "deliveryInstructions",
  "occasion",
  "senderName",
];

export type ResolvedMetaFields = Partial<Record<keyof OrderMetaMapping, string>>;

function readMeta(meta: WooMeta[] | undefined, key: string): string | null {
  const hit = meta?.find((m) => m.key === key);
  return hit && hit.value != null ? String(hit.value).trim() || null : null;
}

/** Возвращает значения внутренних полей, извлечённые по настроенному mapping (только заданные). */
export function resolveMappedOrderFields(meta: WooMeta[] | undefined, mapping: OrderMetaMapping | null | undefined): ResolvedMetaFields {
  const out: ResolvedMetaFields = {};
  if (!mapping) return out;
  for (const field of ORDER_META_FIELDS) {
    const key = mapping[field];
    if (!key) continue;
    const val = readMeta(meta, key);
    if (val != null) out[field] = val;
  }
  return out;
}

/**
 * Собирает частотный список найденных meta keys из выборки заказов (для UI-автоподсказки:
 * владелец видит реальные ключи последних заказов и назначает их полям). Значения НЕ включаем
 * (могут содержать PII) — только ключи и счётчик.
 */
export function collectMetaKeys(orders: { meta_data?: WooMeta[] }[]): { key: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const o of orders) {
    for (const m of o.meta_data ?? []) {
      if (!m.key) continue;
      // Пропускаем «служебные» ключи WooCommerce/плагинов с ведущим подчёркиванием? Оставляем
      // все — владелец сам выберет; часть флористических данных как раз в "_"-ключах.
      counts.set(m.key, (counts.get(m.key) ?? 0) + 1);
    }
  }
  return [...counts.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count);
}
