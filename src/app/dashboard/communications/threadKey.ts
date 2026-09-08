/**
 * Адрес переписки: номер собеседника + QUO-номер магазина. Пара, а не один номер — один и тот
 * же человек мог писать в два разных магазина, и это два разных разговора.
 *
 * Оба значения едут в пути через encodeURIComponent: номер начинается с «+», а PN-идентификатор
 * QUO — обычная строка. Магазина может не быть вовсе (номер не привязан) — тогда «-».
 */
export const NO_STORE = "-";

export function threadHref(phoneE164: string, providerPhoneNumberId: string | null): string {
  return `/dashboard/communications/t/${encodeURIComponent(providerPhoneNumberId || NO_STORE)}/${encodeURIComponent(phoneE164)}`;
}

/**
 * Разбор сегментов адреса. Next отдаёт их СЫРЫМИ, поэтому декодируем сами; битую ссылку
 * (одинокий «%», например) decodeURIComponent роняет исключением — возвращаем null, и
 * страница честно отвечает «не найдено» вместо 500.
 */
export function decodeSegment(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

export function parseThreadPn(raw: string): string | null {
  const decoded = decodeSegment(raw);
  return decoded === null || decoded === NO_STORE ? null : decoded;
}
