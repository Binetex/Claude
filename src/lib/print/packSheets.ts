/**
 * Простая раскладка печати записок. Чистые функции.
 *
 * ПРАВИЛО: заказ занимает СТОЛБЕЦ. Верхняя карточка столбца — получатель, нижняя — текст
 * открытки. На листе US Letter два столбца (сетка 2×2, 4 карточки), поэтому один лист несёт
 * два заказа, а один вертикальный рез посередине отделяет их друг от друга. Внутри столбца
 * заказы НИКОГДА не смешиваются — разрезав лист пополам, вы получаете два целых заказа.
 *
 * Длинный текст → дополнительные СТОЛБЦЫ того же заказа, только с продолжением текста (без
 * заголовков/номеров/частей).
 */

export type RecipientInfo = {
  recipientName: string;
  recipientPhone: string;
  addressLine: string;
  apartment: string | null;
  city: string;
  state: string | null; // отдельно в Order не хранится → null
  zip: string;
};

export type Half =
  | { kind: "recipient"; recipient: RecipientInfo }
  | { kind: "message"; body: string; fontPt: number }
  | { kind: "empty" };

/** Столбец листа: две карточки одна над другой. */
export type Column = { top: Half; bottom: Half };

/** Лист: два столбца. Правого может не быть — тогда половина листа пустая. */
export type Page = { left: Column; right: Column | null };

/**
 * Половины одного заказа: [получатель, текст-часть-1, текст-часть-2, ...].
 * Без текста открытки — одна пустая message-половина (пустое поле).
 */
export function buildOrderHalves(recipient: RecipientInfo, messageParts: string[], fontPt: number): Half[] {
  const rec: Half = { kind: "recipient", recipient };
  const msgs: Half[] =
    messageParts.length > 0
      ? messageParts.map((body) => ({ kind: "message" as const, body, fontPt }))
      : [{ kind: "message" as const, body: "", fontPt }];
  return [rec, ...msgs];
}

/**
 * Пакует половины ПОКАЖДОМУ заказу отдельно (заказы не смешиваются) в столбцы. Каждый заказ
 * занимает целое число столбцов; если у заказа нечётное число половин — нижняя карточка
 * последнего столбца пустая, а следующий заказ начинается с нового столбца.
 */
export function packOrderColumns(orders: Half[][]): Column[] {
  const columns: Column[] = [];
  for (const halves of orders) {
    for (let i = 0; i < halves.length; i += 2) {
      columns.push({ top: halves[i], bottom: halves[i + 1] ?? { kind: "empty" } });
    }
  }
  return columns;
}

/**
 * Раскладывает готовые столбцы по листам. Порядок сохраняется.
 *
 * `perPage = 2` — альбомный лист: два заказа рядом. `perPage = 1` — портретный: лист и есть
 * заказ, получатель сверху, текст снизу. Ширина сетки — единственное, чем эти раскладки
 * отличаются, поэтому упаковка одна на обе.
 */
export function packColumnsIntoPages(columns: Column[], perPage: 1 | 2 = 2): Page[] {
  const pages: Page[] = [];
  for (let i = 0; i < columns.length; i += perPage) {
    pages.push({ left: columns[i], right: perPage === 2 ? (columns[i + 1] ?? null) : null });
  }
  return pages;
}
