/**
 * География почтовых индексов: где находится индекс и насколько далеко один от другого.
 *
 * Нужно ровно для одного вопроса — какая из точек магазина ближе к адресу заказа. Владелец
 * задаёт у точки только её собственный индекс, всё остальное система считает сама: перечислять
 * районы руками бессмысленно, их десятки, и человек всё равно ошибётся.
 *
 * Таблица координат лежит в самом проекте (`zipGeo.data.ts`), поэтому расчёт не ходит наружу:
 * ни геокодера, ни ключей, ни платы за запрос, ни задержки на каждый заказ.
 */
import { ZIP_GEO_BLOB, ZIP_RECORD_WIDTH } from "./zipGeo.data";

export type LatLng = { lat: number; lng: number };

const COUNT = Math.floor(ZIP_GEO_BLOB.length / ZIP_RECORD_WIDTH);

/**
 * Координаты индекса. Двоичный поиск прямо по строке: таблица отсортирована, а раскладывать
 * тридцать три тысячи записей в объекты ради нескольких обращений незачем.
 *
 * Неизвестный индекс — обычное дело (абонентские ящики, новые коды, опечатка), поэтому null
 * здесь не ошибка: выше по течению это означает «выбрать запасную точку».
 */
export function zipCoords(zip: string): LatLng | null {
  const key = zip.trim();
  if (!/^\d{5}$/.test(key)) return null;

  let lo = 0;
  let hi = COUNT - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const at = mid * ZIP_RECORD_WIDTH;
    const found = ZIP_GEO_BLOB.slice(at, at + 5);
    if (found === key) {
      return {
        lat: Number(ZIP_GEO_BLOB.slice(at + 5, at + 11)) / 1000 - 90,
        lng: Number(ZIP_GEO_BLOB.slice(at + 11, at + 17)) / 1000 - 180,
      };
    }
    if (found < key) lo = mid + 1;
    else hi = mid - 1;
  }
  return null;
}

const EARTH_RADIUS_MILES = 3958.8;

/** Расстояние по большому кругу, в милях. */
export function distanceMiles(a: LatLng, b: LatLng): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Расстояние между двумя индексами. null, если хотя бы один неизвестен таблице. */
export function zipDistanceMiles(a: string, b: string): number | null {
  const from = zipCoords(a);
  const to = zipCoords(b);
  if (!from || !to) return null;
  return distanceMiles(from, to);
}
