/**
 * Простая раскладка печати открыток. Чистые функции.
 * ПРАВИЛО: 1 лист US Letter = 1 заказ. Верхняя половина — получатель, нижняя — текст открытки.
 * Длинный текст → дополнительные листы ТОЛЬКО с продолжением текста этого же заказа (без
 * заголовков/номеров/частей). Разные заказы НИКОГДА не смешиваются на одном листе.
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

export type Sheet = { top: Half; bottom: Half };

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
 * Пакует половины ПОКАЖДОМУ заказу отдельно (заказы не смешиваются). Каждый заказ занимает
 * целое число листов; если у заказа нечётное число половин — нижняя половина последнего листа
 * пустая, а следующий заказ начинается с нового листа.
 */
export function packOrderSheets(orders: Half[][]): Sheet[] {
  const sheets: Sheet[] = [];
  for (const halves of orders) {
    for (let i = 0; i < halves.length; i += 2) {
      sheets.push({ top: halves[i], bottom: halves[i + 1] ?? { kind: "empty" } });
    }
  }
  return sheets;
}
