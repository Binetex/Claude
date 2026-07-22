/**
 * Безопасная работа с ТЕКСТОМ ОТКРЫТКИ (Order.cardMessage) для печати. Чистые функции.
 * Текст трактуется как plain text: HTML не исполняется (экранируется), переносы строк
 * сохраняются. Источник — только cardMessage (не customerNote / не delivery instructions).
 */

export const CARD_MESSAGE_MAX = 10_000;

/** Экранирование для безопасной вставки в HTML (никакого исполнения разметки). */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Нормализация при сохранении: CRLF→LF, обрезка хвостовых пробелов строк, лимит длины. */
export function normalizeCardMessage(raw: string): string {
  return raw
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .slice(0, CARD_MESSAGE_MAX);
}

/** Пустой ли текст открытки (после trim). */
export function isBlankCardMessage(s: string | null | undefined): boolean {
  return !s || s.trim().length === 0;
}
