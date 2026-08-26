import "server-only";
/**
 * Справочник точек Google и выбор точки для заказа.
 *
 * Вся арифметика выбора живёт в чистом `locationPick.ts`; здесь — только доступ к базе и
 * правила целостности, которые без базы не проверить.
 *
 * Два таких правила:
 *  1. Запасная точка у магазина ровно одна. Снимаем прежнюю в той же транзакции — иначе
 *     частичный уникальный индекс отвергнет запись, и владелец увидит непонятную ошибку.
 *  2. Один ZIP не может принадлежать двум точкам магазина. Иначе выбор зависел бы от
 *     порядка строк в выдаче, то есть был бы случайным.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { pickLocation, pickedReviewUrl, normalizeZip, type PickResult } from "./locationPick";
import { zipCoords } from "./zipGeo";

export type LocationInput = {
  siteId: string;
  name: string;
  reviewUrl: string;
  /** Индекс точки на карте. Сырая строка из формы: разбор и проверка — здесь же. */
  zipRaw: string;
  isDefault: boolean;
  isActive: boolean;
};

export type SaveResult = { ok: true; id: string } | { ok: false; error: string };

const LOCATION_FIELDS = {
  id: true,
  name: true,
  reviewUrl: true,
  zipCode: true,
  isDefault: true,
  isActive: true,
} as const;

/**
 * Индекс точки из формы. Принимаем ZIP+4 и лишние пробелы — приводим к пяти цифрам.
 *
 * Индекс, которого нет в таблице координат, отвергаем сразу: без координат точка не участвует
 * в расчёте расстояния, то есть не достанется ни одному заказу — и владелец узнал бы об этом
 * только по молчанию, разбираясь, почему отзывы не идут.
 */
export function parseLocationZip(raw: string): { zip: string | null; error: string | null } {
  const value = raw.trim();
  if (!value) return { zip: null, error: null };

  const zip = normalizeZip(value);
  if (zip.length !== 5) return { zip: null, error: "Индекс — это пять цифр, например 90066." };
  if (!zipCoords(zip)) {
    return { zip: null, error: `Индекс ${zip} не найден в справочнике США — проверьте, тот ли он.` };
  }
  return { zip, error: null };
}

function badUrl(url: string): boolean {
  try {
    return new URL(url).protocol !== "https:";
  } catch {
    return true;
  }
}

export async function saveGoogleLocation(input: LocationInput, id: string | null): Promise<SaveResult> {
  const name = input.name.trim();
  const reviewUrl = input.reviewUrl.trim();
  if (!name) return { ok: false, error: "Назовите точку — иначе её не отличить в списке." };
  if (badUrl(reviewUrl)) return { ok: false, error: "Ссылка на отзыв должна быть полным адресом, начиная с https://" };

  const { zip, error: zipError } = parseLocationZip(input.zipRaw);
  if (zipError) return { ok: false, error: zipError };

  // Точка без индекса не участвует в расчёте расстояния — то есть не достанется ни одному
  // заказу. Сохранить такую молча значит отдать владельцу мёртвую строку, которая в списке
  // выглядит рабочей. Запасной точке индекс действительно не нужен: она достаётся не по
  // географии, а по решению.
  if (!zip && !input.isDefault) {
    return {
      ok: false,
      error: "Укажите индекс точки — без него ни один заказ к ней не попадёт. Либо сделайте её запасной.",
    };
  }

  // Правим существующую точку — убеждаемся, что она есть и принадлежит ЭТОМУ магазину.
  // Без проверки исчезнувшая точка роняла действие ошибкой Prisma, а форма молча зависала:
  // ошибка всплывала мимо возвращаемого значения, и сообщения владелец не видел.
  if (id) {
    const existing = await prisma.googleLocation.findUnique({ where: { id }, select: { siteId: true } });
    if (!existing) return { ok: false, error: "Точка уже удалена — обновите страницу." };
    if (existing.siteId !== input.siteId) return { ok: false, error: "Точка принадлежит другому магазину." };
  }

  // Проверки «этот адрес занят другой точкой» больше нет и не нужно: адреса ни за кем не
  // закреплены, каждый заказ достаётся ближайшей точке. Две точки в одном индексе допустимы —
  // географически они неразличимы, и выбор просто останется повторяемым.

  const data = { siteId: input.siteId, name, reviewUrl, zipCode: zip, isDefault: input.isDefault, isActive: input.isActive };

  const saved = await prisma.$transaction(async (tx) => {
    // Снимаем прежнюю запасную ДО записи: иначе частичный уникальный индекс отвергнет вставку.
    if (input.isDefault) {
      await tx.googleLocation.updateMany({
        where: { siteId: input.siteId, isDefault: true, ...(id ? { id: { not: id } } : {}) },
        data: { isDefault: false },
      });
    }
    return id
      ? tx.googleLocation.update({ where: { id }, data, select: { id: true } })
      : tx.googleLocation.create({ data, select: { id: true } });
  });

  return { ok: true, id: saved.id };
}

/**
 * Удаление точки. Пока на точку ссылаться нечему, поэтому удаляем по-настоящему — но об
 * исходе говорим честно.
 *
 * Прежняя версия глотала любую ошибку и всегда возвращала успех: форма закрывалась, владелец
 * считал точку удалённой, а она оставалась на месте.
 *
 * Когда появятся запросы отзывов и найденные отзывы (этапы 2–3), внешний ключ начнёт держать
 * точку — и тогда здесь появится ветка «не удаляем, а выключаем». Заводить её заранее незачем:
 * проверять пока нечего.
 */
export async function deleteGoogleLocation(id: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await prisma.googleLocation.delete({ where: { id } });
    return { ok: true };
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "P2025") return { ok: false, error: "Точка уже удалена — обновите страницу." };
    if (code === "P2003") return { ok: false, error: "Точку нельзя удалить: на неё ссылаются отзывы. Выключите её." };
    throw err;
  }
}

export type SiteLocations = {
  siteId: string;
  siteName: string;
  siteReviewUrl: string | null;
  locations: Array<{
    id: string;
    name: string;
    reviewUrl: string;
    zipCode: string | null;
    isDefault: boolean;
    isActive: boolean;
    /**
     * Есть ли индекс точки в справочнике координат. Проверка при сохранении не покрывает
     * данные, пришедшие мимо формы (перенос из прежней модели), а точка с ненайденным индексом
     * молча не участвует в выборе — в списке она обязана выглядеть сломанной.
     */
    zipKnown: boolean;
  }>;
};

export async function listLocationsBySite(): Promise<SiteLocations[]> {
  const sites = await prisma.site.findMany({
    select: {
      id: true,
      name: true,
      reviewUrl: true,
      googleLocations: { select: LOCATION_FIELDS, orderBy: [{ isDefault: "desc" }, { name: "asc" }] },
    },
    orderBy: { name: "asc" },
  });
  return sites.map((s) => ({
    siteId: s.id,
    siteName: s.name,
    siteReviewUrl: s.reviewUrl,
    locations: s.googleLocations.map((l) => ({
      ...l,
      zipKnown: !!l.zipCode && !!zipCoords(normalizeZip(l.zipCode)),
    })),
  }));
}

export type ResolvedLocation = {
  result: PickResult;
  reviewUrl: string | null;
  locationId: string | null;
  locationName: string | null;
  /** Сколько миль до выбранной точки. null, когда решила не география, а запасной вариант. */
  distanceMiles: number | null;
};

/** Какая точка достанется заказу прямо сейчас. Читает ZIP заказа и точки его магазина. */
export async function resolveLocationForOrder(db: PrismaClient, orderId: string): Promise<ResolvedLocation | null> {
  const order = await db.order.findUnique({
    where: { id: orderId },
    select: {
      zip: true,
      site: { select: { reviewUrl: true, googleLocations: { select: LOCATION_FIELDS } } },
    },
  });
  if (!order) return null;
  return describe(pickLocation(order.zip, order.site.googleLocations, order.site.reviewUrl));
}

/** То же самое для произвольного ZIP — проверка адреса на экране точек. */
export async function resolveLocationForZip(siteId: string, zip: string): Promise<ResolvedLocation | null> {
  const site = await prisma.site.findUnique({
    where: { id: siteId },
    select: { reviewUrl: true, googleLocations: { select: LOCATION_FIELDS } },
  });
  if (!site) return null;
  return describe(pickLocation(zip, site.googleLocations, site.reviewUrl));
}

function describe(result: PickResult): ResolvedLocation {
  return {
    result,
    reviewUrl: pickedReviewUrl(result),
    locationId: result.ok && result.reason !== "site_fallback" ? result.location.id : null,
    locationName: result.ok && result.reason !== "site_fallback" ? result.location.name : null,
    distanceMiles: result.ok && result.reason === "nearest" ? result.distanceMiles : null,
  };
}
