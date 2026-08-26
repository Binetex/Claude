import "server-only";
/**
 * Какая точка Google достаётся заказу.
 *
 * Правило одно: БЛИЖАЙШАЯ к адресу доставки. Владелец задаёт у точки только её собственный
 * почтовый индекс — тот, где точка стоит на карте, — а какие адреса к ней относятся, система
 * считает сама.
 *
 * Так, а не списками районов, потому что список — это ручная работа с десятками кодов, которую
 * человек проделает один раз и забудет обновить, а ошибётся молча: заказ уедет просить отзыв
 * не в тот магазин, и заметить это будет нечем.
 *
 * Расстояние считается по таблице координат внутри проекта (`zipGeo.ts`): без геокодера, без
 * ключей и без запроса наружу на каждый заказ. Модуль помечен "server-only" именно из-за неё:
 * случайный импорт из "use client"-компонента утащил бы в браузер полмегабайта координат, и
 * сборка об этом не предупредила бы.
 *
 * Причина выбора возвращается наружу не для красоты: на экране точек владелец проверяет адрес
 * и должен видеть, сработала ли география или подставился запасной вариант.
 */
import { zipCoords, distanceMiles } from "./zipGeo";

export type PickableLocation = {
  id: string;
  name: string;
  reviewUrl: string;
  /** Индекс, где точка стоит на карте. Пустой — точка не участвует в расчёте расстояния. */
  zipCode: string | null;
  isDefault: boolean;
  isActive: boolean;
};

export type PickReason = "nearest" | "default" | "site_fallback";

export type PickResult =
  | { ok: true; reason: "nearest"; location: PickableLocation; distanceMiles: number }
  | { ok: true; reason: "default"; location: PickableLocation }
  | { ok: true; reason: "site_fallback"; location: null; reviewUrl: string }
  | { ok: false; error: "no_location" };

/**
 * Индекс приводится к пяти цифрам. В заказах встречается «90056-1234» (ZIP+4) и пробелы по
 * краям — без нормализации такой адрес не нашёлся бы в таблице и молча уехал бы к запасной точке.
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
  const orderZip = normalizeZip(zip);
  const orderAt = orderZip ? zipCoords(orderZip) : null;

  if (orderAt) {
    let best: { location: PickableLocation; miles: number } | null = null;
    for (const candidate of active) {
      const at = candidate.zipCode ? zipCoords(normalizeZip(candidate.zipCode)) : null;
      if (!at) continue;
      const miles = distanceMiles(orderAt, at);
      if (!best) {
        best = { location: candidate, miles };
        continue;
      }
      // При РАВНОМ расстоянии решает id, а не порядок в массиве: две точки в одном индексе
      // географически неразличимы (два магазина в одном районе — обычное дело), а точки
      // приходят из запросов без orderBy, где порядок строк Postgres не гарантирует. Без этого
      // два клиента с одним адресом получили бы ссылки на разные точки, и проверка адреса на
      // экране показывала бы одно, а заказ уходил бы на другое.
      const better =
        miles < best.miles || (miles === best.miles && candidate.id < best.location.id);
      if (better) best = { location: candidate, miles };
    }
    if (best) return { ok: true, reason: "nearest", location: best.location, distanceMiles: best.miles };
  }

  // Индекс заказа неизвестен таблице (абонентский ящик, новый код, опечатка) либо ни у одной
  // точки не задан свой индекс. Тогда решает не география, а решение владельца.
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
