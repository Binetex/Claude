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

/**
 * Это время уже записано? Сравнение по значению без учёта регистра и пробелов: «around 11am»
 * из второго сообщения подряд — не новость, а эхо истории, и вторая строка в заметке плюс
 * вторая рассылка владельцу и флористу только шумят.
 */
export function hasReadyTime(existing: string, readyTime: string): boolean {
  const norm = (v: string) => v.toLowerCase().replace(/\s+/g, " ").trim();
  const wanted = norm(readyTime);
  if (!wanted) return true;
  return existing
    .split("\n")
    .some((line) => line.includes("готов принять") && norm(line.slice(line.indexOf("готов принять") + "готов принять".length)) === wanted);
}

/**
 * Есть ли в словах клиента хоть что-то похожее на время или день: цифры с am/pm, «morning»,
 * «noon», «after 5», «tomorrow»… Модель обязана брать время только из НОВОГО сообщения, но
 * инструкцию она нарушает, а эта проверка — нет: «Just buzz the door» времени не содержит.
 */
export function mentionsTime(text: string): boolean {
  const t = text.toLowerCase();
  return (
    /\d/.test(t) ||
    /\b(am|pm|a\.m\.|p\.m\.|noon|midday|morning|afternoon|evening|tonight|today|tomorrow|o'?clock|anytime|any time|whenever|all day|after|before|until|till|by)\b/.test(t)
  );
}
