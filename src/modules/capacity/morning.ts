import { parseTimes, hasByWord, parseWindowText, DAY_START_MIN, type WindowRange } from "@/lib/deliveryWindow";

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

// Разбор часов и слов «до/после» — один на систему, в lib/deliveryWindow.ts.
export { parseTimes, hasByWord } from "@/lib/deliveryWindow";

/** Окно заказа: строгое «с — до», а текст (старый заказ, тест) — разбором. */
function toRange(w: WindowRange | string | null | undefined): WindowRange | null {
  if (w == null) return null;
  return typeof w === "string" ? parseWindowText(w) : w;
}

/**
 * Утренний ли заказ по окну: окно заканчивается к 15:00 («11:00 - 15:00», «09:00 - 15:00»,
 * «2pm» → 13:30–14:30, «Before 3PM» → 11:00–15:00).
 *
 * «11:30 AM - 5:00 PM» утренним НЕ считается: это окно на весь день, и по факту такие заказы
 * уезжали после обеда. Если клиент просил в нём утро, это видно по его пожеланию (wishIsMorning).
 */
export function windowIsMorning(window: WindowRange | string | null | undefined): boolean {
  const r = toRange(window);
  return !!r && r.to <= MORNING_END_HOUR * 60;
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

/**
 * Окно «на весь день» («11:30 AM - 5:00 PM», «до 5 вечера», «Before 5PM») или его нет: время
 * внутри него решает пожелание клиента.
 */
export function isAllDayWindow(window: WindowRange | string | null | undefined): boolean {
  const r = toRange(window);
  if (!r) return true;
  const limit = MORNING_END_HOUR * 60;
  return r.from < limit && r.to > limit;
}

/**
 * Утренний ли заказ. Явное окно — решение магазина, и оно главнее переписки В ОБЕ стороны:
 *  - «5 - 5:30 PM» не становится утренним из-за старого «around 2pm» (PAR-41358: владелец
 *    перенёс на 17:00, а просьба из переписки держала заказ в утре);
 *  - «11:00 - 15:00» не перестаёт быть утренним из-за старого «after 5pm»: если окно вернули на
 *    утро, флорист планирует утро. Когда клиент сам переносит на вечер, ассистент меняет окно
 *    в заказе (assistant/reschedule.ts), так что просьба и окно не расходятся.
 * Только внутри окна «на весь день» решает последнее пожелание клиента.
 */
export function isMorningOrder(order: { window: WindowRange | string | null; customerNote: string | null }): boolean {
  if (windowIsMorning(order.window)) return true;
  if (!isAllDayWindow(order.window)) return false;
  const latest = readyTimeWishes(order.customerNote)[0];
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
 * Сколько нужно на заказ день в день: собрать букет, вызвать курьера и довезти. Зависит от
 * размера букета и от того, как далеко адрес от флориста (владелец 27.09.2026: «маленький
 * букет рядом с флористом мы можем быстро сделать»).
 *
 * Цифры — стартовые, их подкручивают по вкладке «Как успели».
 */
/** Сборка маленького букета. */
export const PREP_SMALL_MIN = 75;
/** Сборка большого (от $250). */
export const PREP_BIG_MIN = 105;
/** Вызвать курьера и дождаться, пока он заберёт букет. */
export const COURIER_PICKUP_MIN = 30;
/** Дорога: миля по прямой ≈ 4 минуты по Лос-Анджелесу (дороги не прямые, пробки). */
export const DRIVE_MIN_PER_MILE = 4;
/** Адрес или место флориста неизвестны — дорога как «средняя»: 45 минут. */
export const UNKNOWN_DRIVE_MIN = 45;
/** Дальше двух часов дороги не считаем: это уже не наш район, решает человек. */
const MAX_DRIVE_MIN = 120;

export function leadMinutes(args: { big: boolean; miles: number | null }): number {
  const prep = args.big ? PREP_BIG_MIN : PREP_SMALL_MIN;
  const drive = args.miles == null ? UNKNOWN_DRIVE_MIN : Math.min(MAX_DRIVE_MIN, Math.round(args.miles * DRIVE_MIN_PER_MILE));
  return prep + COURIER_PICKUP_MIN + drive;
}

/** Когда о заказе ничего не известно (новый клиент): маленький букет, «средняя» дорога — 2,5 ч. */
export const SAME_DAY_LEAD_MIN = leadMinutes({ big: false, miles: null });
/** «К 12:00–12:30» обещаем, только если успеваем к этому времени. */
const NOON_PROMISE_BY_MIN = 12 * 60 + 30;

/** Самое раннее время доставки сегодня, минуты от полуночи (кратно 30). */
export function earliestToday(nowMinutes: number, leadMin: number = SAME_DAY_LEAD_MIN): number {
  return Math.ceil((nowMinutes + leadMin) / 30) * 30;
}

/**
 * Поправка на текущее время, если доставка СЕГОДНЯ. Загрузка флориста не знает, который час:
 * пустое утро в 13:00 — это не «привезём к 12–12:30», а упущенное утро, потому что на сборку и
 * дорогу нужно SAME_DAY_LEAD_MIN.
 */
export function adjustForNow(verdict: MorningVerdict, isToday: boolean, nowMinutes: number, leadMin: number = SAME_DAY_LEAD_MIN): MorningVerdict {
  if (!isToday) return verdict;
  const earliest = earliestToday(nowMinutes, leadMin);
  // Раньше 15:00 уже не успеть — утра сегодня нет, даже если у флориста пусто.
  if (earliest >= MORNING_END_HOUR * 60) return "FULL";
  if (verdict === "FIRST" && earliest > NOON_PROMISE_BY_MIN) return "AVAILABLE";
  return verdict;
}

/** Обычное обещание «утром, 13:00–15:00» — с этого часа. */
export const AVAILABLE_FROM_MIN = 13 * 60;

/**
 * С какого часа сегодня можно обещать «утром, …–15:00»: не раньше 13:00 и не раньше самого
 * раннего времени. В 12:00 это уже 14:30, и «ориентировочно 13–15» было бы неправдой.
 */
export function availableFromToday(nowMinutes: number, leadMin: number = SAME_DAY_LEAD_MIN): number {
  return Math.max(AVAILABLE_FROM_MIN, earliestToday(nowMinutes, leadMin));
}

/** «2:30 PM», «1 PM» — время для текста клиенту. */
export function clockLabelEn(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${h % 12 === 0 ? 12 : h % 12}${m ? `:${String(m).padStart(2, "0")}` : ""} ${h < 12 ? "AM" : "PM"}`;
}

/** Опоздание в пределах этого — не опоздание (решение владельца: «20 минут — ничего страшного»). */
export const LATE_TOLERANCE_MIN = 20;

/**
 * Когда клиент хотел получить букет, в минутах от полуночи. Источник — его последнее пожелание
 * о времени, если оно есть, иначе окно заказа:
 *  - «by noon», «until 1:40» — от начала окна до названного часа;
 *  - «after 3.30 pm» — с названного часа до конца окна (или три часа, если окно раньше);
 *  - «between 11:30 and 12:30», «4-5pm» — как есть;
 *  - «12 pm», «around 2» — полчаса в обе стороны.
 */
export function wantedRange(window: WindowRange | string | null, wish: string | null): WindowRange | null {
  const range = toRange(window);
  if (!wish || !(wishIsMorning(wish) || wishIsAfternoon(wish))) return range;
  const times = parseTimes(wish.replace(/\b\d{3,}\b/g, " "));
  if (!times.length) return range;
  const text = wish.toLowerCase();
  if (hasByWord(text)) {
    const to = times[times.length - 1];
    return { from: Math.min(range?.from ?? DAY_START_MIN, to), to };
  }
  if (/\bafter\b/.test(text)) {
    const from = times[0];
    return { from, to: range && range.to > from ? range.to : from + 180 };
  }
  if (times.length > 1) return { from: times[0], to: times[times.length - 1] };
  return { from: times[0] - 30, to: times[0] + 30 };
}

/** «42 мин», «3 ч 12 мин», «2 ч». */
export function fmtDuration(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (!h) return `${m} мин`;
  return m ? `${h} ч ${m} мин` : `${h} ч`;
}
