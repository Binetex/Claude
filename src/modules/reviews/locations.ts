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

export type LocationInput = {
  siteId: string;
  name: string;
  reviewUrl: string;
  /** Сырая строка из формы. Разбор и проверка — здесь же: два места разошлись бы. */
  zipsRaw: string;
  isDefault: boolean;
  isActive: boolean;
};

export type SaveResult = { ok: true; id: string } | { ok: false; error: string };

const LOCATION_FIELDS = {
  id: true,
  name: true,
  reviewUrl: true,
  zips: true,
  isDefault: true,
  isActive: true,
} as const;

/**
 * ZIP-ы из формы: нормализуем, схлопываем дубли, держим порядок ввода — и ОТДЕЛЬНО
 * возвращаем то, что на ZIP не похоже.
 *
 * Молча выбрасывать непонятое нельзя. «90210, 9021, 90048» сохранилось бы как два кода,
 * строка в списке выглядела бы нормально — просто на один ZIP короче, — а заказы того района
 * тихо уходили бы на запасную точку. Точность разметки это единственное, ради чего весь
 * справочник и существует.
 */
export function parseZips(raw: string): { zips: string[]; rejected: string[] } {
  const seen = new Set<string>();
  const rejected: string[] = [];
  for (const part of raw.split(/[\s,;]+/)) {
    if (!part.trim()) continue;
    const zip = normalizeZip(part);
    if (zip.length === 5) seen.add(zip);
    else rejected.push(part.trim());
  }
  return { zips: [...seen], rejected };
}

/**
 * Только https. Сообщение об ошибке обещает именно его, а http-ссылка ушла бы клиенту в SMS
 * и открылась бы у части людей предупреждением о небезопасном соединении вместо формы отзыва.
 * Ссылки Google в любом случае https.
 */
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

  const { zips, rejected } = parseZips(input.zipsRaw);
  if (rejected.length > 0) {
    return { ok: false, error: `Это не похоже на ZIP: ${rejected.join(", ")}. ZIP — пять цифр.` };
  }

  // Правим существующую точку — убеждаемся, что она есть и принадлежит ЭТОМУ магазину.
  // Без проверки исчезнувшая точка роняла действие ошибкой Prisma, а форма молча зависала:
  // ошибка всплывала мимо возвращаемого значения, и сообщения владелец не видел.
  if (id) {
    const existing = await prisma.googleLocation.findUnique({ where: { id }, select: { siteId: true } });
    if (!existing) return { ok: false, error: "Точка уже удалена — обновите страницу." };
    if (existing.siteId !== input.siteId) return { ok: false, error: "Точка принадлежит другому магазину." };
  }

  // Конфликт ZIP считаем только среди АКТИВНЫХ точек и только для активной точки: выключенная
  // в выборе не участвует, и держать её ZIP в заложниках незачем — иначе перенести коды с
  // закрытой точки на новую было бы нельзя, пока не почистишь мёртвую запись.
  if (input.isActive && zips.length > 0) {
    const siblings = await prisma.googleLocation.findMany({
      where: { siteId: input.siteId, isActive: true, ...(id ? { id: { not: id } } : {}) },
      select: { name: true, zips: true },
    });
    const taken = new Map<string, string>();
    for (const s of siblings) for (const z of s.zips) taken.set(z, s.name);
    const clash = zips.filter((z) => taken.has(z));
    if (clash.length > 0) {
      return { ok: false, error: `ZIP ${clash.join(", ")} уже закреплён за точкой «${taken.get(clash[0])}».` };
    }
  }

  const data = { siteId: input.siteId, name, reviewUrl, zips, isDefault: input.isDefault, isActive: input.isActive };

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
  locations: Array<{ id: string; name: string; reviewUrl: string; zips: string[]; isDefault: boolean; isActive: boolean }>;
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
    locations: s.googleLocations,
  }));
}

export type ResolvedLocation = {
  result: PickResult;
  reviewUrl: string | null;
  locationId: string | null;
  locationName: string | null;
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
  };
}
