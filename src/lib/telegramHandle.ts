/**
 * Ник в Telegram («@arina»): им флориста отмечают в срочных уведомлениях — в группе с отметкой
 * Telegram пиликает лично ей, даже если чат заглушён (владелец 10.10.2026). Хранится в
 * `User.telegramId` уже с «@». Пустая строка — ника нет (null); не похоже на ник — undefined.
 */
export function normalizeTelegramHandle(raw: string): string | null | undefined {
  const v = raw.trim().replace(/^https?:\/\/t\.me\//i, "").replace(/^@/, "");
  if (!v) return null;
  return /^[A-Za-z0-9_]{5,32}$/.test(v) ? `@${v}` : undefined;
}
