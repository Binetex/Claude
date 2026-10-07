/**
 * Что клиент НАЗВАЛ сам — день и время. Заказ двигается только на это (владелец 30.09.2026:
 * «переносить можно, только если конкретно названа реальная дата, чёткое время … или "до"»).
 *
 * Модель отдаёт, что пообещал её ответ (`new_delivery_date`, `confirmed_from/until`), и обещание
 * бывает её собственным. На «the earliest you can» она пообещала «from 3:30», окно стало
 * 3:30–9 PM (THEFLOW-20876), и флорист прочитал это как «клиенту можно поздно», чего клиент не
 * говорил. Поэтому обещание принимается, только если совпадает со словами клиента. «Any time»,
 * «as early as possible», «morning», «another day» — не время и не дата: день и окно остаются
 * как были, слова идут в заметку.
 *
 * Чистый модуль: ни БД, ни «сейчас» — день сообщения передаётся параметром.
 */

const WORD_HOURS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};

/** Предлоги, после которых число — это час: «by 2», «after five», «between 10 and noon». */
const PREP = String.raw`(?:by|after|before|until|till|til|around|at|from|past|between|and|to|about|approx(?:imately)?)`;
/**
 * Предлоги открытого «после»: окно до конца дня — ровно то, что сказал клиент. Начало промежутка
 * («between 5 and 6», «5-6») — тоже «не раньше»: раньше его клиента нет дома (THEFLOW-20925).
 */
const OPEN_AFTER = String.raw`(?:after|from|past|later than|no earlier than|not before|not until|no sooner than|between)`;
const AMPM = String.raw`(a\.?\s?m\.?|p\.?\s?m\.?)`;
/** Что после числа делает его не часом: «5 mins», «by the 5th», «$5», «5 miles». */
const NOT_A_HOUR = String.raw`(?!\s*(?:mins?\b|minutes?|hours?|hrs?|miles?|mi\b|days?|weeks?|%|th\b|st\b|nd\b|rd\b|\$|\d))`;

/** Кандидаты часа без am/pm: «5» — это 17:00, «10» — 10:00, «7» — и 7:00, и 19:00. */
function hourCandidates(h: number, m: number, ampm: string | null): number[] {
  if (h > 23 || m > 59) return [];
  if (ampm) {
    if (h < 1 || h > 12) return [];
    const pm = ampm.replace(/[\s.]/g, "").toLowerCase() === "pm";
    return [((h % 12) + (pm ? 12 : 0)) * 60 + m];
  }
  if (h >= 13) return [h * 60 + m];
  if (h === 0) return [];
  const out = [h === 12 ? 12 * 60 + m : h * 60 + m];
  if (h < 12) out.push((h + 12) * 60 + m);
  // Доставок ночью и на рассвете не бывает: «2» — это 14:00, а не 2 ночи, «10» — 10 утра.
  return out.filter((x) => x >= 6 * 60 && x <= 21 * 60);
}

function hourOf(token: string): number | null {
  const t = token.toLowerCase();
  if (t in WORD_HOURS) return WORD_HOURS[t];
  const n = Number(t);
  return Number.isInteger(n) ? n : null;
}

/** Все часы, названные клиентом, в минутах суток (без повторов). */
export function clientNamedTimes(text: string): number[] {
  const t = text.toLowerCase();
  const out = new Set<number>();
  const add = (xs: number[]) => xs.forEach((x) => out.add(x));

  // «3pm», «10:30 am», «5 p.m.»
  for (const m of t.matchAll(new RegExp(String.raw`\b(\d{1,2})(?::([0-5]\d))?\s*${AMPM}(?![a-z])`, "g"))) {
    add(hourCandidates(Number(m[1]), Number(m[2] ?? 0), m[3]));
  }
  // «15:30», «3:30» без am/pm
  for (const m of t.matchAll(/\b([01]?\d|2[0-3]):([0-5]\d)\b(?!\s*(?:a\.?\s?m|p\.?\s?m))/g)) add(hourCandidates(Number(m[1]), Number(m[2]), null));
  // «by 2», «after five», «between 10 and noon»
  for (const m of t.matchAll(new RegExp(String.raw`\b${PREP}\s+(\d{1,2}|${Object.keys(WORD_HOURS).join("|")})(?::([0-5]\d))?(?:\s*${AMPM}(?![a-z])|\b${NOT_A_HOUR})`, "g"))) {
    const h = hourOf(m[1]);
    if (h != null) add(hourCandidates(h, Number(m[2] ?? 0), m[3] ?? null));
  }
  // «5-7pm», «10 to 12», «11–1»
  for (const m of t.matchAll(new RegExp(String.raw`\b(\d{1,2})(?::([0-5]\d))?\s*(?:-|–|—|to)\s*(\d{1,2})(?::([0-5]\d))?(?:\s*${AMPM}(?![a-z])|\b${NOT_A_HOUR})`, "g"))) {
    const ampm = m[5] ?? null;
    add(hourCandidates(Number(m[1]), Number(m[2] ?? 0), null));
    add(hourCandidates(Number(m[3]), Number(m[4] ?? 0), ampm));
  }
  // «5 o'clock»
  for (const m of t.matchAll(/\b(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s*o'?clock\b/g)) {
    const h = hourOf(m[1]);
    if (h != null) add(hourCandidates(h, 0, null));
  }
  if (/\b(noon|midday)\b/.test(t)) out.add(12 * 60);
  return [...out].sort((a, b) => a - b);
}

/** Часы открытого «после» («after 5», «from 3:30»): окно с них и до конца дня. */
export function clientOpenAfterTimes(text: string): number[] {
  const t = text.toLowerCase();
  const out = new Set<number>();
  for (const m of t.matchAll(new RegExp(String.raw`\b${OPEN_AFTER}\s+(\d{1,2}|${Object.keys(WORD_HOURS).join("|")}|noon)(?::([0-5]\d))?(?:\s*${AMPM}(?![a-z])|\b${NOT_A_HOUR})`, "g"))) {
    if (m[1] === "noon") { out.add(12 * 60); continue; }
    const h = hourOf(m[1]);
    if (h != null) hourCandidates(h, Number(m[2] ?? 0), m[3] ?? null).forEach((x) => out.add(x));
  }
  // Начало промежутка «5-6», «10 to 12»: am/pm у конца относится и к началу («5-7pm»).
  for (const m of t.matchAll(new RegExp(String.raw`\b(\d{1,2})(?::([0-5]\d))?\s*(?:-|–|—|to)\s*(\d{1,2})(?::([0-5]\d))?(?:\s*${AMPM}(?![a-z])|\b${NOT_A_HOUR})`, "g"))) {
    hourCandidates(Number(m[1]), Number(m[2] ?? 0), m[5] ?? null).forEach((x) => out.add(x));
  }
  return [...out].sort((a, b) => a - b);
}

const DAY_MS = 86_400_000;
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const WEEKDAYS: [RegExp, number][] = [
  [/\bsundays?\b/, 0], [/\bmondays?\b/, 1], [/\b(tuesdays?|tues)\b/, 2], [/\b(wednesdays?|weds)\b/, 3],
  [/\b(thursdays?|thurs?)\b/, 4], [/\b(fridays?|fri)\b/, 5], [/\bsaturdays?\b/, 6],
];
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** Дата «месяц/число» ближайшая к дню сообщения: прошедшая в этом году — значит, следующий год. */
function monthDay(messageDay: string, month: number, day: number, year: number | null): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const y = year ?? Number(messageDay.slice(0, 4));
  const iso = `${String(year != null && year < 100 ? 2000 + year : y).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  if (Number.isNaN(Date.parse(`${iso}T00:00:00Z`)) || new Date(`${iso}T00:00:00Z`).getUTCDate() !== day) return null;
  if (year == null && iso < messageDay) return monthDay(messageDay, month, day, y + 1);
  return iso;
}

/** Конкретные дни, которые назвал клиент (YYYY-MM-DD), относительно дня его сообщения. */
export function clientNamedDays(text: string, messageDay: string): string[] {
  let t = text.toLowerCase();
  const out = new Set<string>();
  if (/\bday after (tomorrow|tmrw)\b/.test(t)) {
    out.add(addDays(messageDay, 2));
    t = t.replace(/\bday after (tomorrow|tmrw)\b/g, " ");
  }
  if (/\b(tomorrow|tmrw|tmr|tomorow|tommorow|tommorrow)\b/.test(t)) out.add(addDays(messageDay, 1));
  if (/\b(today|tonight)\b/.test(t)) out.add(messageDay);
  const dow = new Date(`${messageDay}T00:00:00Z`).getUTCDay();
  for (const [re, target] of WEEKDAYS) {
    if (!re.test(t)) continue;
    const ahead = (target - dow + 7) % 7;
    // Тот же день недели, что сегодня, — это и сегодня, и через неделю: решает совпадение с моделью.
    if (ahead === 0) { out.add(messageDay); out.add(addDays(messageDay, 7)); }
    else out.add(addDays(messageDay, ahead));
  }
  for (const m of t.matchAll(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/g)) {
    const d = monthDay(messageDay, Number(m[1]), Number(m[2]), m[3] ? Number(m[3]) : null);
    if (d) out.add(d);
  }
  const monthRe = String.raw`(${MONTHS.join("|")})[a-z]*\.?`;
  for (const m of t.matchAll(new RegExp(String.raw`\b${monthRe}\s+(\d{1,2})(?:st|nd|rd|th)?\b`, "g"))) {
    const d = monthDay(messageDay, MONTHS.indexOf(m[1]) + 1, Number(m[2]), null);
    if (d) out.add(d);
  }
  for (const m of t.matchAll(new RegExp(String.raw`\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?${monthRe}`, "g"))) {
    const d = monthDay(messageDay, MONTHS.indexOf(m[2]) + 1, Number(m[1]), null);
    if (d) out.add(d);
  }
  return [...out].sort();
}

/**
 * Обещание модели, оставленное только там, где его назвал клиент:
 *  - день — если клиент назвал именно этот день;
 *  - «с» и «до» — если это часы из его слов; «около 5» (5:00–5:30) — по одному названному часу;
 *  - только «до» («by 2») — если клиент назвал этот час;
 *  - только «с» — если клиент сказал «после»/«с» этого часа: окно до конца дня — его слова.
 * Всё остальное обнуляется: заказ по догадке не двигаем.
 */
export function clientConfirmed(a: {
  text: string;
  messageDay: string;
  newDate: string | null;
  from: number | null;
  until: number | null;
}): { newDate: string | null; from: number | null; until: number | null } {
  const newDate = a.newDate && clientNamedDays(a.text, a.messageDay).includes(a.newDate) ? a.newDate : null;
  const times = clientNamedTimes(a.text);
  const named = (m: number | null) => m != null && times.includes(m);
  const around = (from: number, until: number) => until > from && until - from <= 60;

  if (a.from != null && a.until != null) {
    const ok = (named(a.from) && (named(a.until) || around(a.from, a.until))) || (named(a.until) && around(a.from, a.until));
    return ok ? { newDate, from: a.from, until: a.until } : { newDate, from: null, until: null };
  }
  if (a.until != null) return { newDate, from: null, until: named(a.until) ? a.until : null };
  if (a.from != null) return { newDate, from: clientOpenAfterTimes(a.text).includes(a.from) ? a.from : null, until: null };
  return { newDate, from: null, until: null };
}
