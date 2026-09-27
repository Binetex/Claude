/**
 * Клиент словами перенёс доставку с утра на после 15:00 — меняем окно в заказе сами.
 *
 * Решение владельца (27.09.2026): «надо менять время». Раньше слова клиента попадали только в
 * заметку («готов принять after 5pm»), а окно оставалось утренним: флорист планировал утро,
 * загрузка утра держала место, сайт TheFlow держал утренний слот закрытым.
 *
 * Меняем УЗКО — только то, что ассистенту и так разрешено подтверждать без человека: более
 * позднее время В ТОТ ЖЕ день. Другой день, раннее время, «any time» — не трогаем.
 *
 * Чистая функция — решение и новое окно; побочные эффекты делает handler.
 */
import { windowIsMorning, wishIsAfternoon } from "@/modules/capacity/morning";

/**
 * Клиент говорит о дне: «tomorrow», «Saturday», «10/3», «another day». Дата — только через
 * косую черту: «4.30» и «3.30» в переписке — это время, а не число («after 3.30 pm» иначе
 * считалось другим днём, и перенос на вечер молча не происходил).
 */
const DAY_WORDS = /\b(tomorrow|tmrw|monday|tuesday|wednesday|thursday|friday|saturday|sunday|weekend|next week|another day|different day|day after|later date|\d{1,2}\/\d{1,2})\b/i;

export function mentionsDay(text: string): boolean {
  return DAY_WORDS.test(text);
}

export function laterWindowFromWish(currentWindow: string | null, readyTime: string): string | null {
  if (!windowIsMorning(currentWindow)) return null;
  if (mentionsDay(readyTime)) return null;
  if (!wishIsAfternoon(readyTime)) return null;
  // Окно в карточке — слова клиента, как владелец и сам их пишет («4.30 - 5pm», «after 5pm»).
  const window = readyTime.replace(/\b(today|tonight)\b/gi, "").replace(/\s+/g, " ").trim();
  return window || null;
}

/** Дальше этого клиенту переносить сами не будем: ошибка модели в дате — не на месяц вперёд. */
export const MAX_DAYS_AHEAD = 30;

function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Что сделать с заказом по словам клиента (решение владельца 27.09.2026: позже — всегда можно,
 * и на следующий день тоже). Возвращает новые день и окно или null, если трогать нечего.
 *
 *  - другой день: только ПОЗЖЕ текущего дня доставки и не дальше MAX_DAYS_AHEAD от сегодня;
 *    окно — слова клиента о времени, если назвал, иначе прежнее;
 *  - тот же день: как раньше — только с утра на после 15:00 (laterWindowFromWish).
 */
export function planReschedule(args: {
  todayStr: string;
  currentDay: string;
  currentWindow: string | null;
  readyTime: string | null;
  newDate: string | null;
}): { day: string; window: string } | null {
  const window = args.currentWindow ?? "";
  if (args.newDate) {
    if (args.newDate <= args.currentDay) return null;
    if (args.newDate < args.todayStr || args.newDate > addDays(args.todayStr, MAX_DAYS_AHEAD)) return null;
    const words = (args.readyTime ?? "")
      .replace(/\b(tomorrow|tmrw|today|tonight|on|next|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi, "")
      .replace(/\s+/g, " ")
      .trim();
    const named = words && /\d|noon|morning|afternoon|evening/i.test(words) && !/\b(any ?time|all day|whenever)\b/i.test(words);
    return { day: args.newDate, window: named ? words : window };
  }
  if (!args.readyTime) return null;
  const later = laterWindowFromWish(args.currentWindow, args.readyTime);
  return later ? { day: args.currentDay, window: later } : null;
}
