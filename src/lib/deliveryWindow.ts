/**
 * Время доставки строго «с — до».
 *
 * У заказа окно хранится двумя числами — `Order.windowFrom` / `Order.windowTo`, минуты от
 * полуночи по часам магазина (LA). От них работают загрузка утра, опоздания, расписание, запись
 * в Woo и ассистент. Текст `Order.deliveryWindow` остаётся для всего, что его показывает (SMS,
 * Telegram, печать), но при правке его пишет система — одним форматом «11:00 - 15:00».
 *
 * Свободный текст окна был главным источником ошибок: при ручной правке появлялось «С 6PM»,
 * «после 5PM», «5.30 pm», «до 12», «желательно первым», и каждую запись приходилось угадывать
 * регулярками. Разбор текста остался в одном месте — здесь: для окон, которые присылают магазины,
 * и для старых заказов. Не разобралось — окна нет (`null`), человек увидит «время не задано».
 *
 * Чистый модуль: ни БД, ни «сейчас».
 */

export type WindowRange = { from: number; to: number };

/** Шаг выбора времени в интерфейсе (решение владельца: 30 минут). */
export const WINDOW_STEP_MIN = 30;
/** Конец рабочего дня доставки: «после 5» без конца — это до 21:00 (решение владельца). */
export const DAY_END_MIN = 21 * 60;
/** Начало, когда окно задано только концом («до 3», «by noon»). */
export const DAY_START_MIN = 11 * 60;

/**
 * Часы, названные в строке, в минутах от полуночи, по порядку.
 *
 * Окна приходят из шести магазинов как есть: «11:00 - 15:00», «11:00 AM - 4:00 PM»,
 * «4.30 - 5pm», «2pm», «Before 3PM», «до 5 вечера». Голое число без am/pm меньше восьми — это
 * день, а не утро: ночью мы не возим, а «4.30 - 5pm» иначе стало бы половиной пятого утра.
 * am/pm, стоящий у следующего числа («11 - 3pm»), относится и к предыдущему, если не спорит с ним.
 */
export function parseTimes(raw: string | null | undefined): number[] {
  const text = (raw ?? "").toLowerCase();
  const re = /(\d{1,2})(?:[:.](\d{2}))?\s*(a\.?m\.?|p\.?m\.?|noon)?/g;
  const found: { h: number; m: number; ap: "a" | "p" | null }[] = [];
  for (const m of text.matchAll(re)) {
    const h = Number(m[1]);
    const min = m[2] ? Number(m[2]) : 0;
    if (h > 23 || min > 59) continue;
    const ap = m[3]?.startsWith("a") ? "a" : m[3]?.startsWith("p") || m[3] === "noon" ? "p" : null;
    found.push({ h, m: min, ap });
  }
  if (/\bnoon\b/.test(text) && !found.length) return [12 * 60];
  return found.map(({ h, m, ap }, i) => {
    let hour = h;
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
 * «К такому-то часу»: before/by/until/till и русское «до». \b в JS знает только латиницу, поэтому
 * «до» ловится своими границами — иначе «до 3» и «до 5 вечера» читались как одиночное время.
 */
export function hasByWord(text: string | null | undefined): boolean {
  return /\b(before|by|until|till)\b|(?:^|[^а-яё])до(?=[^а-яё]|$)/i.test(text ?? "");
}

/** «С такого-то часа»: after/from/starting и русские «после», «с», «со». */
export function hasAfterWord(text: string | null | undefined): boolean {
  return /\b(after|from|starting)\b|(?:^|[^а-яё])(после|с|со)(?=[^а-яё]|$)/i.test(text ?? "");
}

/**
 * Текст окна → «с — до». Правила:
 *  - промежуток («11:00 - 15:00», «11:30 AM - 5:00 PM», «4.30 - 5pm») — как есть;
 *  - «до N» («до 12», «until 3pm», «Before 3PM») — с 11:00 (или за час до N, если N раньше) до N;
 *  - «после N» («после 5PM», «С 6PM», «after 10am») — с N до 21:00;
 *  - одиночное время («2pm», «5.30 pm») — полчаса в обе стороны;
 *  - словами («morning», «afternoon», «вечером») — слоты дня: 11–15, 15–19, 18–21;
 *  - без часов и слов («желательно первым», «—», пусто) — null: окна нет, его задаст человек.
 */
export function parseWindowText(raw: string | null | undefined): WindowRange | null {
  const text = (raw ?? "").trim();
  const times = parseTimes(text);
  if (!times.length) {
    // Словами: «tomorrow afternoon», «вечером» — слоты дня.
    if (/\bmorning\b|утр/i.test(text)) return { from: DAY_START_MIN, to: 15 * 60 };
    if (/\bafternoon\b|днём|днем/i.test(text)) return { from: 15 * 60, to: 19 * 60 };
    if (/\b(evening|tonight|night)\b|вечер/i.test(text)) return { from: 18 * 60, to: DAY_END_MIN };
    return null;
  }
  if (hasByWord(text)) {
    const to = times[times.length - 1];
    return valid({ from: Math.min(DAY_START_MIN, to - 60), to });
  }
  if (hasAfterWord(text) && times.length === 1) {
    const from = times[0];
    return valid({ from, to: from < DAY_END_MIN ? DAY_END_MIN : from + 60 });
  }
  if (times.length > 1) return valid({ from: times[0], to: times[times.length - 1] });
  return valid({ from: times[0] - 30, to: times[0] + 30 });
}

function valid(r: WindowRange): WindowRange | null {
  return isValidRange(r) ? r : null;
}

export function isValidRange(r: { from: number; to: number } | null | undefined): r is WindowRange {
  return !!r && Number.isInteger(r.from) && Number.isInteger(r.to) && r.from >= 0 && r.to <= 24 * 60 && r.from < r.to;
}

/** «HH:MM» → минуты; всё прочее — null. */
export function parseHm(raw: string | null | undefined): number | null {
  const m = (raw ?? "").trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h <= 24 && min <= 59 ? h * 60 + min : null;
}

/** Минуты → «HH:MM». */
export function fmtHm(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}

/**
 * Окно → текст для `Order.deliveryWindow`: «11:00 - 15:00». Этот же формат уже присылает TheFlow,
 * и `formatDeliveryWindow` клиенту переводит его в «11 AM - 3 PM».
 */
export function formatWindowText(r: WindowRange): string {
  return `${fmtHm(r.from)} - ${fmtHm(r.to)}`;
}

/**
 * Окно заказа: сначала строгие поля, если их нет (старый заказ, не разобралось при приёме) —
 * разбор текста. Все, кто считает время, берут окно отсюда.
 */
export function windowOf(order: { windowFrom?: number | null; windowTo?: number | null; deliveryWindow?: string | null }): WindowRange | null {
  const r = { from: order.windowFrom ?? NaN, to: order.windowTo ?? NaN };
  if (isValidRange(r)) return r;
  return parseWindowText(order.deliveryWindow);
}

/** Поля для записи в заказ по окну: оба числа и текст одним форматом. Нет окна — всё пусто. */
export function windowFields(r: WindowRange | null): { windowFrom: number | null; windowTo: number | null; deliveryWindow: string } {
  return r ? { windowFrom: r.from, windowTo: r.to, deliveryWindow: formatWindowText(r) } : { windowFrom: null, windowTo: null, deliveryWindow: "" };
}

/** Варианты времени для выбора: 07:00…22:00 с шагом WINDOW_STEP_MIN (+ текущее, если вне сетки). */
export function windowOptions(extra: (number | null | undefined)[] = []): number[] {
  const set = new Set<number>();
  for (let m = 7 * 60; m <= 22 * 60; m += WINDOW_STEP_MIN) set.add(m);
  for (const e of extra) if (e != null && e >= 0 && e <= 24 * 60) set.add(e);
  return [...set].sort((a, b) => a - b);
}
