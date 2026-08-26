"use server";
/**
 * Точки Google — действия владельца. ТОЛЬКО OWNER: ссылка на отзыв уходит клиенту от лица
 * магазина, и решать, куда она ведёт, колл-центру и флористу не по чину.
 *
 * Логика и проверки целостности — в modules/reviews/locations.ts; здесь права, разбор формы
 * и обновление страницы.
 */
import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/rbac";
import { prisma } from "@/lib/db";
import { saveGoogleLocation, deleteGoogleLocation, resolveLocationForZip } from "@/modules/reviews/locations";

const PATH = "/dashboard/reviews";

export type LocationFormResult = { ok?: true; error?: string };

export async function saveLocationAction(input: {
  id: string | null;
  siteId: string;
  name: string;
  reviewUrl: string;
  zipRaw: string;
  isDefault: boolean;
  isActive: boolean;
}): Promise<LocationFormResult> {
  await requireRole("OWNER");
  const res = await saveGoogleLocation(
    {
      siteId: input.siteId,
      name: input.name,
      reviewUrl: input.reviewUrl,
      zipRaw: input.zipRaw,
      isDefault: input.isDefault,
      isActive: input.isActive,
    },
    input.id
  );
  if (!res.ok) return { error: res.error };
  revalidatePath(PATH);
  return { ok: true };
}

export async function deleteLocationAction(id: string): Promise<LocationFormResult> {
  await requireRole("OWNER");
  const res = await deleteGoogleLocation(id);
  if (!res.ok) return { error: res.error };
  revalidatePath(PATH);
  return { ok: true };
}

/**
 * Общая ссылка магазина — запасной вариант, когда ни одна точка не подошла (индекс заказа
 * неизвестен) или точек ещё нет вовсе.
 *
 * Переехала сюда из «Автоматизаций»: там она была вторым местом, где задаётся то же самое, и
 * переменная {{review_url}} брала именно её вместо ближайшей точки. Держать одну ссылку в двух
 * разделах — верный способ однажды поправить не ту.
 */
export async function saveSiteReviewUrlAction(siteId: string, reviewUrl: string): Promise<LocationFormResult> {
  await requireRole("OWNER");
  const value = reviewUrl.trim();
  if (value && !/^https:\/\//i.test(value)) return { error: "Ссылка должна начинаться с https://" };
  const site = await prisma.site.findUnique({ where: { id: siteId }, select: { id: true } });
  if (!site) return { error: "Магазин не найден." };

  await prisma.site.update({ where: { id: siteId }, data: { reviewUrl: value || null } });
  revalidatePath(PATH);
  // Правила автоматизаций предупреждают о ненастроенной ссылке — их страница тоже устарела.
  revalidatePath("/dashboard/automations");
  return { ok: true };
}

/**
 * Проверка адреса: какая точка достанется заказу с таким индексом и на каком она расстоянии.
 *
 * Нужна потому, что расстояние — вещь неочевидная: две точки могут стоять так, что граница
 * между ними пройдёт не там, где ожидает владелец. Проверка показывает границу до того, как
 * по ней уедет первый клиент.
 */
export async function checkZipAction(siteId: string, zip: string): Promise<{
  name: string | null;
  reason: "nearest" | "default" | "site_fallback" | "none";
  reviewUrl: string | null;
  miles: number | null;
}> {
  await requireRole("OWNER");
  const resolved = await resolveLocationForZip(siteId, zip);
  if (!resolved || !resolved.result.ok) return { name: null, reason: "none", reviewUrl: null, miles: null };
  return {
    name: resolved.locationName,
    reason: resolved.result.reason,
    reviewUrl: resolved.reviewUrl,
    miles: resolved.distanceMiles,
  };
}
