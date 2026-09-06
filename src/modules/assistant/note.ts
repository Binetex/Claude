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
 * Есть ли в словах клиента время. Проверка нужна потому, что модель тянет время из истории:
 * на «Just buzz the door» она повторяла вчерашнее «around 11am», и оно уходило в заметку и людям.
 *
 * Считается временем: часы с am/pm или двоеточием («11am», «2:30»), голое число рядом со
 * словом-предлогом времени («after 5», «by 11»), слова вроде morning/noon/asap и числительные
 * словами. Просто цифра в адресе («Apt 4B», «code 1408») временем НЕ считается — на этом
 * прежняя проверка пропускала всё подряд.
 */
export function mentionsTime(text: string): boolean {
  const t = text.toLowerCase();
  if (/\b\d{1,2}(:\d{2})?\s*(am|pm|a\.m\.|p\.m\.|o'?clock)/.test(t)) return true;
  if (/\b\d{1,2}:\d{2}\b/.test(t)) return true;
  if (/\b(by|after|before|until|till|around|at|from|past)\s+\d{1,2}\b/.test(t)) return true;
  return /\b(morning|afternoon|evening|tonight|noon|midday|midnight|asap|lunch|lunchtime|dinner|breakfast|anytime|any time|whenever|all day|today|tomorrow|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/.test(t);
}
