/**
 * Загрузка утра: сколько работы у флориста к 15:00 и можно ли обещать клиенту утро.
 *
 * Чистый модуль: ни БД, ни «сейчас». Правило выведено из недели прода (20–27.09.2026):
 *  - раньше полудня не доставляется ничего; первый букет флориста приезжает около 12:00–13:00,
 *    дальше примерно по одному в 30–45 минут;
 *  - большой букет (от $250) делать заметно дольше — он весит два маленьких;
 *  - больше ~4 баллов к 15:00 флорист не успевает: пятый-шестой букет опаздывал за окно.
 *
 * Считаем штуки, а не выплату флористу: владелец решил мерить работу ценой букета.
 */

/** Дешевле этого — не букет, а добавка (ваза, шарик, шоколад, открытка): работы не добавляет. */
export const BOUQUET_MIN_PRICE = 100;
/** От этой цены букет «большой»: делать его дольше. */
export const BIG_BOUQUET_PRICE = 250;
export const BIG_BOUQUET_POINTS = 2;
/** Утро — всё, что должно приехать до этого часа. */
export const MORNING_END_HOUR = 15;
export const DEFAULT_MORNING_CAPACITY = 4;

export type OrderItemLike = { price: number; quantity: number };

/** Баллы заказа. Заказ без позиций-букетов (ручной, без состава) — один маленький букет. */
export function orderPoints(items: OrderItemLike[]): number {
  let points = 0;
  for (const it of items) {
    if (!(it.price >= BOUQUET_MIN_PRICE)) continue;
    points += (it.price >= BIG_BOUQUET_PRICE ? BIG_BOUQUET_POINTS : 1) * Math.max(1, it.quantity);
  }
  return points || 1;
}

export function isBigOrder(items: OrderItemLike[]): boolean {
  return items.some((it) => it.price >= BIG_BOUQUET_PRICE);
}

/**
 * Часы, названные в строке, в минутах от полуночи, по порядку.
 *
 * Окна приходят из шести магазинов как есть: «11:00 - 15:00», «11:00 AM - 4:00 PM»,
 * «4.30 - 5pm», «2pm», «Before 3PM», «до 5 вечера». Голое число без am/pm меньше восьми — это
 * день, а не утро: ночью мы не возим, а «4.30 - 5pm» иначе стало бы половиной пятого утра.
 * am/pm, стоящий только у последнего числа («11 - 3pm»), относится и к предыдущим.
 */
export function parseTimes(raw: string | null | undefined): number[] {
  const text = (raw ?? "").toLowerCase();
  const re = /(\d{1,2})(?:[:.](\d{2}))?\s*(a\.?m\.?|p\.?m\.?|noon)?/g;
  const found: { h: number; m: number; ap: "a" | "p" | null }[] = [];
  for (const m of text.matchAll(re)) {
    const h = Number(m[1]);
    const min = m[2] ? Number(m[2]) : 0;
    if (h > 23 || min > 59) continue;
    // Одинокая цифра без минут и без am/pm внутри слова вроде «Apt 4» сюда не попадает:
    // строка окна содержит только время, а пожелания разбирает wishIsMorning.
    const ap = m[3]?.startsWith("a") ? "a" : m[3]?.startsWith("p") || m[3] === "noon" ? "p" : null;
    found.push({ h, m: min, ap });
  }
  if (/\bnoon\b/.test(text) && !found.length) return [12 * 60];
  return found.map(({ h, m, ap }, i) => {
    let hour = h;
    // Подпись берём у ближайшего следующего времени с am/pm, если число её не противоречит:
    // «11 - 3pm» — это 11 утра, а не 11 вечера (одиннадцать больше трёх).
    const next = found.slice(i + 1).find((f) => f.ap);
    const suffix = ap ?? (next && h <= 12 ? (h <= next.h || next.h === 12 ? next.ap : "a") : null);
    if (suffix === "p" && hour < 12) hour += 12;
    else if (suffix === "a" && hour === 12) hour = 0;
    else if (!suffix && hour < 8) hour += 12;
    return hour * 60 + m;
  });
}

/**
 * Утренний ли заказ по окну: окно заканчивается к 15:00 («11:00 - 15:00», «09:00 - 15:00»),
 * одиночное время раньше 15:00 («2pm») или «до N» с N не позже 15:00 («Before 3PM»).
 *
 * «11:30 AM - 5:00 PM» утренним НЕ считается: это окно на весь день, и по факту такие заказы
 * уезжали после обеда. Если клиент просил в нём утро, это видно по его пожеланию (wishIsMorning).
 */
export function windowIsMorning(window: string | null | undefined): boolean {
  const times = parseTimes(window);
  if (!times.length) return false;
  const limit = MORNING_END_HOUR * 60;
  if (/\b(before|by|until|till)\b|\bдо\b/i.test(window ?? "")) return times[times.length - 1] <= limit;
  if (times.length === 1) return times[0] < limit;
  return times[times.length - 1] <= limit;
}

/**
 * Пожелание клиента утреннее: «by noon», «11:00 am», «between 11:30 and 12:30», «until 1:40».
 * «after 3.30 pm», «any time», «4-5pm» — нет.
 */
export function wishIsMorning(wish: string): boolean {
  const text = wish.toLowerCase();
  if (/\b(anytime|any time|all day|whenever)\b/.test(text) && !/\b(by|before|until|till)\b/.test(text)) return false;
  if (/\bafter\b/.test(text)) return false;
  if (/\bnoon\b|\bmorning\b/.test(text)) return true;
  const times = parseTimes(text.replace(/\b\d{3,}\b/g, " "));
  if (!times.length) return false;
  // «by 3pm» — к трём, это ещё утро; «at 3pm» — уже нет.
  const limit = MORNING_END_HOUR * 60;
  return /\b(by|before|until|till)\b/.test(text) ? times[0] <= limit : times[0] < limit;
}

/**
 * Пожелания времени из заметки заказа: ассистент пишет их строкой «… готов принять <время>»
 * (assistant/note.ts). Свежие сверху.
 */
export function readyTimeWishes(customerNote: string | null | undefined): string[] {
  return (customerNote ?? "")
    .split("\n")
    .map((l) => l.match(/готов принять\s+(.+)$/)?.[1]?.trim() ?? "")
    .filter(Boolean);
}

/**
 * Пожелание клиента переносит его на после 15:00: «6 PM», «after 5», «4-5pm». Тогда утро он
 * не занимает, даже если окно в карточке осталось утренним: клиенты переносят словами в SMS, а
 * окно руками правят не всегда. «any time», «until 6pm» переносом не считаются.
 */
export function wishIsAfternoon(wish: string): boolean {
  const text = wish.toLowerCase();
  if (/\b(anytime|any time|all day|whenever)\b/.test(text)) return false;
  if (/\b(by|before|until|till|closes)\b/.test(text)) return false;
  const times = parseTimes(text.replace(/\b\d{3,}\b/g, " "));
  return times.length > 0 && times[0] >= MORNING_END_HOUR * 60;
}

export function isMorningOrder(order: { window: string | null; customerNote: string | null }): boolean {
  // Смотрим последнее пожелание: клиент мог передумать («around 2pm» → «6 PM»).
  const latest = readyTimeWishes(order.customerNote)[0];
  if (latest && wishIsAfternoon(latest)) return false;
  if (windowIsMorning(order.window)) return true;
  return !!latest && wishIsMorning(latest);
}

/**
 * Что можно сказать клиенту про утро:
 *  - FIRST — у флориста утром ещё пусто: «начинаем в 11, скорее всего около 12–12:30»;
 *  - AVAILABLE — место есть, но не первым: «утром, ориентировочно 13:00–15:00»;
 *  - FULL — не влезает или утро закрыто: предлагаем 15:00–19:00.
 */
export type MorningVerdict = "FIRST" | "AVAILABLE" | "FULL";

export function morningVerdict(args: { taken: number; own: number; capacity: number; closed: boolean }): MorningVerdict {
  if (args.closed) return "FULL";
  if (args.taken + args.own > args.capacity) return "FULL";
  // Большой букет первым к полудню не успевает: он один занимает всё начало утра.
  if (args.taken === 0 && args.own < BIG_BOUQUET_POINTS) return "FIRST";
  return "AVAILABLE";
}

/**
 * Сколько нужно на заказ день в день: собрать букет и довезти. Владелец: «за 1,5 часа точно не
 * успеем». Самое раннее время сегодня — сейчас плюс это, с округлением вверх до получаса.
 */
export const SAME_DAY_LEAD_MIN = 150;
/** «К 12:00–12:30» обещаем, только если успеваем к этому времени. */
const NOON_PROMISE_BY_MIN = 12 * 60 + 30;

/** Самое раннее время доставки сегодня, минуты от полуночи (кратно 30). */
export function earliestToday(nowMinutes: number): number {
  return Math.ceil((nowMinutes + SAME_DAY_LEAD_MIN) / 30) * 30;
}

/**
 * Поправка на текущее время, если доставка СЕГОДНЯ. Загрузка флориста не знает, который час:
 * пустое утро в 13:00 — это не «привезём к 12–12:30», а упущенное утро, потому что на сборку и
 * дорогу нужно SAME_DAY_LEAD_MIN.
 */
export function adjustForNow(verdict: MorningVerdict, isToday: boolean, nowMinutes: number): MorningVerdict {
  if (!isToday) return verdict;
  const earliest = earliestToday(nowMinutes);
  if (earliest > MORNING_END_HOUR * 60) return "FULL";
  if (verdict === "FIRST" && earliest > NOON_PROMISE_BY_MIN) return "AVAILABLE";
  return verdict;
}

/** Опоздание в пределах этого — не опоздание (решение владельца: «20 минут — ничего страшного»). */
export const LATE_TOLERANCE_MIN = 20;

/**
 * Когда клиент хотел получить букет, в минутах от полуночи. Источник — его последнее пожелание
 * о времени, если оно есть, иначе окно заказа:
 *  - «by noon», «until 1:40» — от начала окна до названного часа;
 *  - «after 3.30 pm» — с названного часа до конца окна (или три часа, если окно раньше);
 *  - «between 11:30 and 12:30», «4-5pm», «11:00 - 15:00» — как есть;
 *  - «12 pm», «around 2» — полчаса в обе стороны.
 */
export function wantedRange(window: string | null, wish: string | null): { from: number; to: number } | null {
  const useWish = !!wish && (wishIsMorning(wish) || wishIsAfternoon(wish));
  const source = useWish ? wish! : window ?? "";
  const times = parseTimes(source.replace(/\b\d{3,}\b/g, " "));
  if (!times.length) return null;
  const win = parseTimes(window);
  const text = source.toLowerCase();
  if (/\b(by|before|until|till)\b|\bдо\s/.test(text)) {
    const to = times[times.length - 1];
    return { from: Math.min(win[0] ?? 11 * 60, to), to };
  }
  if (/\bafter\b/.test(text)) {
    const from = times[0];
    const end = win.length > 1 ? win[win.length - 1] : 0;
    return { from, to: end > from ? end : from + 180 };
  }
  if (times.length > 1) return { from: times[0], to: times[times.length - 1] };
  return { from: times[0] - 30, to: times[0] + 30 };
}
