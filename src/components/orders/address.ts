/**
 * Адрес получателя одинаково собирается в трёх карточках заказа и в ссылке на карту.
 * Держим сборку в одном месте: раньше строка «улица, квартира, город индекс» была написана
 * заново на каждой странице, и они уже расходились — где-то терялась квартира.
 */
export type RecipientAddress = {
  addressLine: string;
  apartment?: string | null;
  city: string;
  zip: string;
};

/** Строки адреса для карточки: улица с квартирой отдельно от «город индекс». */
export function recipientAddressLines(a: RecipientAddress): string[] {
  return [
    [a.addressLine, a.apartment].filter((p) => p && String(p).trim()).join(", "),
    [a.city, a.zip].filter((p) => p && String(p).trim()).join(" "),
  ].filter((l) => l.trim().length > 0);
}

/** Ссылка «Открыть на карте». Квартира в запрос не идёт — она мешает геокодеру. */
export function recipientMapsUrl(a: RecipientAddress): string {
  const query = `${a.addressLine}, ${a.city} ${a.zip}`;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

/** Адрес отправителя (billing) для карточки заказчика у владельца. */
export function senderAddressLines(s: {
  addressLine?: string | null;
  apartment?: string | null;
  city?: string | null;
  province?: string | null;
  zip?: string | null;
  country?: string | null;
}): string[] {
  return [
    [s.addressLine, s.apartment].filter(Boolean).join(", "),
    [s.city, s.province, s.zip].filter(Boolean).join(" "),
    s.country ?? "",
  ].filter((l) => l.trim().length > 0);
}
