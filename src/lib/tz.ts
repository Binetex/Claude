// Таймзона магазина по умолчанию (если у сайта не проставлена Site.timezone). O'Hara — США.
export const DEFAULT_STORE_TZ = "America/Los_Angeles";

/** Календарная дата (YYYY-MM-DD) переданного момента в указанной таймзоне. */
export function localDateStr(date: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/** Сегодняшняя дата (YYYY-MM-DD) в таймзоне магазина. */
export function todayStrInTz(tz: string | null | undefined, now: Date = new Date()): string {
  return localDateStr(now, tz || DEFAULT_STORE_TZ);
}

/**
 * Приводит МОМЕНТ ВРЕМЕНИ к тому виду, в котором хранится `Order.deliveryDate`, — UTC-полночь
 * ЛОКАЛЬНОГО дня магазина.
 *
 * Нужно там, где день доставки выводится из отметки времени (например, приём заказа без явной
 * даты доставки берёт дату самого заказа). Класть туда сырой timestamp нельзя: полночь UTC
 * наступает в Лос-Анджелесе в 17:00, поэтому у вечернего заказа UTC-календарная дата уже
 * ЗАВТРАШНЯЯ, и весь код, который читает поле как «UTC-полночь локального дня», сдвигает такой
 * заказ на сутки вперёд.
 */
export function utcMidnightOfLocalDay(at: Date, tz: string | null | undefined): Date {
  return new Date(`${localDateStr(at, tz || DEFAULT_STORE_TZ)}T00:00:00.000Z`);
}

/**
 * Разбирает ДАТУ ДОСТАВКИ, пришедшую строкой (note_attributes Shopify, meta WooCommerce, форма),
 * в UTC-полночь того же календарного дня. Возвращает null, если строки нет или она не разбирается.
 *
 * Зачем не `new Date(raw)`: у него два разных поведения, и одно из них зависит от таймзоны
 * СЕРВЕРА. «2026-08-15» разбирается как полночь UTC, а «August 15, 2026» — как полночь в зоне
 * процесса. Пока прод в UTC, оба дают одно и то же; после переезда сервера в любую другую зону
 * все «человеческие» даты доставки уехали бы на сутки — молча и сразу по всем заказам.
 *
 * Поэтому берётся именно КАЛЕНДАРНАЯ дата, как она написана: у ISO-строк — прямо из текста,
 * у остальных — локальными компонентами разобранной даты (то есть теми же числами, что в строке).
 */
export function parseLocalDayToUtcMidnight(raw: string | null | undefined): Date | null {
  const s = (raw ?? "").trim();
  if (!s) return null;

  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) {
    const d = new Date(`${iso[1]}-${iso[2]}-${iso[3]}T00:00:00.000Z`);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  const parsed = new Date(s);
  if (Number.isNaN(parsed.getTime())) return null;
  const y = parsed.getFullYear();
  const m = String(parsed.getMonth() + 1).padStart(2, "0");
  const day = String(parsed.getDate()).padStart(2, "0");
  return new Date(`${y}-${m}-${day}T00:00:00.000Z`);
}

/** true, если строка — валидная IANA-таймзона. */
export function isValidTimeZone(tz: string | null | undefined): boolean {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * UTC-диапазон [gte, lt) для СЕГОДНЯШНЕГО календарного дня в таймзоне `tz`.
 * deliveryDate хранится как UTC-полночь локального дня, поэтому фильтр `deliveryDate >= gte &&
 * deliveryDate < lt` корректно выбирает «сегодня по местному времени магазина». Ключевое: когда
 * в UTC уже следующие сутки, а в tz ещё предыдущие, `localDateStr` вернёт локальную дату (предыдущую),
 * и диапазон нацелится на правильный локальный день (см. req о границе суток).
 */
export function utcDayRangeForLocalToday(tz: string | null | undefined, now: Date = new Date()): { gte: Date; lt: Date } {
  const dateStr = localDateStr(now, tz || DEFAULT_STORE_TZ); // "YYYY-MM-DD" в местной зоне
  const gte = new Date(`${dateStr}T00:00:00.000Z`);
  const lt = new Date(gte.getTime() + 24 * 60 * 60 * 1000);
  return { gte, lt };
}

/** Смещение таймзоны `tz` относительно UTC в минутах в момент `at` (LA летом = −420). */
function tzOffsetMinutes(tz: string, at: Date): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const map: Record<string, string> = {};
  for (const p of dtf.formatToParts(at)) map[p.type] = p.value;
  const asUTC = Date.UTC(+map.year, +map.month - 1, +map.day, +map.hour === 24 ? 0 : +map.hour, +map.minute, +map.second);
  return (asUTC - at.getTime()) / 60000;
}

/**
 * UTC-момент для локальных ДАТЫ (`YYYY-MM-DD`) и ВРЕМЕНИ (`HH:mm`) в таймзоне `tz`.
 * Учитывает DST (двойная сверка смещения на границе перевода). Пример: 04:00 в
 * America/Los_Angeles на 2026-07-18 (PDT, UTC−7) → 2026-07-18T11:00:00Z.
 */
export function zonedLocalTimeToUtc(dateStr: string, timeHHmm: string, tz: string | null | undefined): Date {
  const zone = tz || DEFAULT_STORE_TZ;
  const [h, m] = timeHHmm.split(":").map((x) => parseInt(x, 10));
  const hh = String(Number.isFinite(h) ? h : 0).padStart(2, "0");
  const mm = String(Number.isFinite(m) ? m : 0).padStart(2, "0");
  const guess = new Date(`${dateStr}T${hh}:${mm}:00Z`); // локальное «настенное» время как если бы это был UTC
  const off1 = tzOffsetMinutes(zone, guess);
  let utc = new Date(guess.getTime() - off1 * 60000);
  const off2 = tzOffsetMinutes(zone, utc);
  if (off2 !== off1) utc = new Date(guess.getTime() - off2 * 60000);
  return utc;
}

/**
 * Классифицирует `deliveryDate` (UTC-полночь локального дня) относительно СЕГОДНЯ в таймзоне `tz`.
 * Чистый строительный блок для БУДУЩЕГО per-site расчёта метрик «Сегодня/Завтра»: когда магазины
 * окажутся в разных часовых поясах, счётчики нужно считать по `Site.timezone` КАЖДОГО магазина
 * (сгруппировать заказы по зоне → классифицировать → просуммировать), а не по одному глобальному tz.
 * Сейчас в проде это не используется (все магазины — LA).
 */
export function deliveryDayBucket(
  deliveryDate: Date,
  tz: string | null | undefined,
  now: Date = new Date()
): "today" | "tomorrow" | "other" {
  const today = utcDayRangeForLocalToday(tz, now);
  const tomorrowLt = new Date(today.lt.getTime() + 24 * 60 * 60 * 1000);
  if (deliveryDate >= today.gte && deliveryDate < today.lt) return "today";
  if (deliveryDate >= today.lt && deliveryDate < tomorrowLt) return "tomorrow";
  return "other";
}
