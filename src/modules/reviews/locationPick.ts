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

export function pickLocation(
  zip: string | null | undefined,
  locations: PickableLocation[],
  siteReviewUrl: string | null | undefined
): PickResult {
  const active = locations.filter((l) => l.isActive);
  const needle = normalizeZip(zip);

  if (needle) {
    const byZip = active.find((l) => l.zips.some((z) => normalizeZip(z) === needle));
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
