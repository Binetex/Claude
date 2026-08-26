/**
 * Какая точка Google достаётся заказу. Чистая функция: на вход — ZIP заказа и точки
 * магазина, на выход — выбранная точка и ПОЧЕМУ именно она.
 *
 * Ключ выбора — ZIP, а не город. Город в заказах пишут как попало («LA», «Los Angeles»,
 * «Ladera Heights»), а ZIP заполнен всегда и однозначен. Расстояние до адреса не считаем:
 * это геокодирование каждого заказа ради разницы, которую владелец знает наперёд и
 * выражает разметкой ZIP.
 *
 * Причина выбора возвращается наружу не для красоты: на экране точек владелец проверяет
 * адрес и должен видеть, попал ли ZIP в разметку или сработал запасной вариант. Без этого
 * «работает» и «случайно совпало» неразличимы.
 */

export type PickableLocation = {
  id: string;
  name: string;
  reviewUrl: string;
  zips: string[];
  isDefault: boolean;
  isActive: boolean;
};

export type PickReason = "zip" | "default" | "site_fallback";

export type PickResult =
  | { ok: true; reason: "zip" | "default"; location: PickableLocation }
  | { ok: true; reason: "site_fallback"; location: null; reviewUrl: string }
  | { ok: false; error: "no_location" };

/**
 * ZIP приводится к пяти цифрам. В заказах встречается «90056-1234» (ZIP+4) и пробелы по
 * краям — без нормализации такой адрес не нашёл бы свою точку и молча уехал бы к запасной.
 */
export function normalizeZip(raw: string | null | undefined): string {
  const digits = (raw ?? "").trim().replace(/\D/g, "");
  return digits.slice(0, 5);
}

/**
 * Правило покрытия точки — числовой ОТРЕЗОК кодов. Три записи, и все три сводятся к отрезку:
 *
 *   90210        одиночный код     → [90210, 90210]
 *   90064-90069  диапазон          → [90064, 90069]
 *   900*         префикс           → [90000, 90099]
 *
 * Отрезки нужны потому, что перечислять коды поштучно нереально: в одном Лос-Анджелесе их под
 * сотню, и разметка двух точек превращалась бы в час работы с опечатками. Диапазон описывает
 * район одной строкой.
 *
 * Всё сведено к отрезкам ещё и ради проверки пересечений: два правила разных точек, накрывающие
 * один код, сделали бы выбор точки случайным, а пересечение отрезков проверяется тривиально.
 */
export type ZipRange = { from: number; to: number };

export function parseZipRule(raw: string): ZipRange | null {
  const rule = raw.trim();
  if (!rule) return null;

  const range = rule.match(/^(\d{5})\s*[-–—]\s*(\d{5})$/);
  if (range) {
    const from = Number(range[1]);
    const to = Number(range[2]);
    // «90069-90064» — тот же диапазон, записанный задом наперёд. Разворачиваем, а не отвергаем.
    return { from: Math.min(from, to), to: Math.max(from, to) };
  }

  const prefix = rule.match(/^(\d{1,4})\*$/);
  if (prefix) {
    const pad = 5 - prefix[1].length;
    return { from: Number(prefix[1] + "0".repeat(pad)), to: Number(prefix[1] + "9".repeat(pad)) };
  }

  const single = rule.match(/^(\d{5})(?:[-\s]?\d{4})?$/);
  if (single) return { from: Number(single[1]), to: Number(single[1]) };

  return null;
}

export function zipRulesOverlap(a: ZipRange, b: ZipRange): boolean {
  return a.from <= b.to && b.from <= a.to;
}

function ruleCovers(rule: string, zip: string): boolean {
  const range = parseZipRule(rule);
  if (!range) return false;
  const n = Number(zip);
  return n >= range.from && n <= range.to;
}

export function pickLocation(
  zip: string | null | undefined,
  locations: PickableLocation[],
  siteReviewUrl: string | null | undefined
): PickResult {
  const active = locations.filter((l) => l.isActive);
  const needle = normalizeZip(zip);

  if (needle) {
    const byZip = active.find((l) => l.zips.some((rule) => ruleCovers(rule, needle)));
    if (byZip) return { ok: true, reason: "zip", location: byZip };
  }

  const fallback = active.find((l) => l.isDefault);
  if (fallback) return { ok: true, reason: "default", location: fallback };

  // Старое поле магазина — нижняя ступень запаса. Оно кормит живые рассылки через
  // {{review_url}}, поэтому пока справочник не заполнен, заказ всё равно получает ссылку.
  const legacy = (siteReviewUrl ?? "").trim();
  if (legacy) return { ok: true, reason: "site_fallback", location: null, reviewUrl: legacy };

  return { ok: false, error: "no_location" };
}

/** Ссылка, которую в итоге отправят клиенту. Собрана здесь, чтобы её не выводили заново. */
export function pickedReviewUrl(res: PickResult): string | null {
  if (!res.ok) return null;
  return res.reason === "site_fallback" ? res.reviewUrl : res.location.reviewUrl;
}
