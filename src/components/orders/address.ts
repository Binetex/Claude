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

/**
 * Ссылка «Открыть на карте».
 *
 * Квартира в запрос НЕ идёт — она сбивает геокодер: «South Le Doux Road, 302, Los Angeles»
 * Google разбирает не как дом 302 на этой улице, и точка уезжает (THEFLOW-20537). Показываем
 * квартиру в тексте адреса, но в карту отдаём только улицу, город и индекс.
 *
 * Этой ссылкой обязаны пользоваться ВСЕ места, где адрес кликабелен: список заказов и карточка
 * телеграма собирали её сами и обе тянули квартиру, поэтому из списка и из карточки заказа
 * открывались разные точки на карте.
 */
export function recipientMapsUrl(a: {
  addressLine?: string | null;
  city?: string | null;
  zip?: string | null;
}): string {
  const query = [a.addressLine, [a.city, a.zip].filter((p) => p && String(p).trim()).join(" ")]
    .map((p) => (p ?? "").trim())
    .filter(Boolean)
    .join(", ");
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
