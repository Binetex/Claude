/**
 * Слова клиента о времени — в заметку заказа, СВЕРХУ, с датой и разделителем.
 *
 * Сверху, а не снизу: заметку читает флорист с телефона, и свежее должно быть первым.
 * Разделитель — чтобы строка ассистента не слиплась с тем, что написали руками.
 * Чистая функция: формат заметки — договорённость с владельцем, и её проверяет тест.
 */
export const NOTE_SEPARATOR = "———";

export function prependReadyTimeNote(existing: string, readyTime: string, at: Date, tz: string | null): string {
  const stamp = new Intl.DateTimeFormat("ru-RU", {
    timeZone: tz || "America/Los_Angeles",
    day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
  }).format(at);
  const line = `${stamp} · Клиент (SMS): готов принять ${readyTime.trim()}`;
  const rest = existing.trim();
  return rest ? `${line}\n${NOTE_SEPARATOR}\n${rest}` : line;
}
