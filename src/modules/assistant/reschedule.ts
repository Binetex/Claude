/**
 * Что ассистент пообещал клиенту про день и время — то и ставим в заказ сами.
 *
 * Решение владельца (27.09.2026): «надо менять время», и позже — всегда можно, хоть на следующий
 * день. Раньше слова клиента попадали только в заметку, а окно оставалось прежним: флорист
 * планировал утро, расписание держало место, сайт TheFlow держал утренний слот закрытым.
 *
 * Время берётся не из слов клиента, а из того, что ОТВЕТ пообещал (`confirmed_from` /
 * `confirmed_until` модели): обещание уже проверено по расписанию — раньше самого раннего
 * времени ответ не уходит (prompt.ts::parseReply). Так окно заказа и сказанное клиенту не
 * расходятся, и второго разбора слов клиента рядом с моделью нет.
 *
 * Чистая функция — решение и новое окно; побочные эффекты делает handler.
 */
import { DAY_END_MIN, DAY_START_MIN, isValidRange, type WindowRange } from "@/lib/deliveryWindow";

/**
 * Клиент говорит о дне: «tomorrow», «Saturday», «10/3», «another day». Дата — только через
 * косую черту: «4.30» и «3.30» в переписке — это время, а не число («after 3.30 pm» иначе
 * считалось другим днём, и перенос на вечер молча не происходил).
 */
const DAY_WORDS = /\b(tomorrow|tmrw|monday|tuesday|wednesday|thursday|friday|saturday|sunday|weekend|next week|another day|different day|day after|later date|\d{1,2}\/\d{1,2})\b/i;

export function mentionsDay(text: string): boolean {
  return DAY_WORDS.test(text);
}

export type Confirmed = { from: number | null; until: number | null };

/**
 * Окно по обещанному: «с» и «до» — как есть; только «до» — с прежнего начала окна (если оно
 * раньше), иначе с 11:00 или за час до конца; только «с» — до 21:00 («после 5» → 17:00–21:00).
 */
export function confirmedWindow(current: WindowRange | null, c: Confirmed): WindowRange | null {
  let r: WindowRange | null = null;
  if (c.from != null && c.until != null) r = { from: c.from, to: c.until };
  else if (c.until != null) r = { from: current && current.from < c.until ? current.from : Math.min(DAY_START_MIN, c.until - 60), to: c.until };
  else if (c.from != null) r = { from: c.from, to: DAY_END_MIN };
  return r && isValidRange(r) ? r : null;
}

/** Дальше этого клиенту переносить сами не будем: ошибка модели в дате — не на месяц вперёд. */
export const MAX_DAYS_AHEAD = 30;

function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Новые день и окно заказа или null, если трогать нечего:
 *  - другой день — только ПОЗЖЕ текущего дня доставки и не дальше MAX_DAYS_AHEAD от сегодня;
 *    окно — обещанное, если ответ обещал время, иначе прежнее;
 *  - тот же день — обещанное окно.
 */
export function planReschedule(args: {
  todayStr: string;
  currentDay: string;
  currentWindow: WindowRange | null;
  confirmed: Confirmed;
  newDate: string | null;
}): { day: string; window: WindowRange | null } | null {
  const window = confirmedWindow(args.currentWindow, args.confirmed);
  if (args.newDate) {
    if (args.newDate <= args.currentDay) return null;
    if (args.newDate < args.todayStr || args.newDate > addDays(args.todayStr, MAX_DAYS_AHEAD)) return null;
    return { day: args.newDate, window: window ?? args.currentWindow };
  }
  return window ? { day: args.currentDay, window } : null;
}
