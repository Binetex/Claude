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
import { saveGoogleLocation, deleteGoogleLocation, resolveLocationForZip } from "@/modules/reviews/locations";

const PATH = "/dashboard/reviews";

export type LocationFormResult = { ok?: true; error?: string };

export async function saveLocationAction(input: {
  id: string | null;
  siteId: string;
  name: string;
  reviewUrl: string;
  zipsRaw: string;
  isDefault: boolean;
  isActive: boolean;
}): Promise<LocationFormResult> {
  await requireRole("OWNER");
  const res = await saveGoogleLocation(
    {
      siteId: input.siteId,
      name: input.name,
      reviewUrl: input.reviewUrl,
      zipsRaw: input.zipsRaw,
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
 * Проверка адреса: какая точка достанется заказу с таким ZIP.
 *
 * Нужна потому, что разметка ZIP — это данные, а не код: опечатка в одном коде тихо уводит
 * часть заказов к запасной точке, и заметить это иначе можно только по факту отправки.
 */
export async function checkZipAction(siteId: string, zip: string): Promise<{
  name: string | null;
  reason: "zip" | "default" | "site_fallback" | "none";
  reviewUrl: string | null;
}> {
  await requireRole("OWNER");
  const resolved = await resolveLocationForZip(siteId, zip);
  if (!resolved || !resolved.result.ok) return { name: null, reason: "none", reviewUrl: null };
  return { name: resolved.locationName, reason: resolved.result.reason, reviewUrl: resolved.reviewUrl };
}
