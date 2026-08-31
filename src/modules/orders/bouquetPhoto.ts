import "server-only";
/**
 * Фото готового букета на заказе.
 *
 * Кладут его все, кто ведёт заказ: флорист — потому что он его собрал, владелец и колл-центр —
 * потому что заказ может вести кто угодно, а букет иногда собирает и везёт сам владелец. Раньше
 * загрузка была только у флориста, и в таком случае фото приложить было некому.
 *
 * Право на заказ у ролей разное, и разница ровно одна: флорист работает только со СВОИМ
 * заказом, остальные — с любым. Проверка у флориста живёт в самом `updateMany` (без совпадения
 * по `currentFloristId` не обновится ни одна строка), поэтому чужой заказ отсекается там же,
 * где обновляется, а не отдельной выборкой, которую можно забыть.
 *
 * Статус заказа не трогаем: «готов» выражается статусом, а фото — самостоятельное действие,
 * доступное и после доставки.
 */
import type { Role } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { imageStorage } from "@/lib/storage";

export type UploadPhotoResult = { ok: true; photoUrl: string } | { ok: false; error: string };

export async function saveBouquetPhoto(
  orderId: string,
  photoDataUrl: string,
  actor: { role: Role; floristId: string | null }
): Promise<UploadPhotoResult> {
  if (!photoDataUrl?.startsWith("data:image/")) return { ok: false, error: "Некорректное изображение." };

  let photoUrl: string;
  try {
    photoUrl = await imageStorage.saveImage(photoDataUrl);
  } catch (err) {
    console.error(`[orders] не удалось сохранить фото букета для заказа ${orderId}:`, err instanceof Error ? err.message : String(err));
    return { ok: false, error: "Не удалось сохранить фото. Попробуйте ещё раз." };
  }

  // Флорист — только свой заказ. Условие в UPDATE, а не в отдельной проверке: так его нельзя
  // обойти и нельзя забыть.
  const scope =
    actor.role === "FLORIST"
      ? { id: orderId, currentFloristId: actor.floristId }
      : { id: orderId };

  const { count } = await prisma.order.updateMany({ where: scope, data: { bouquetPhotoUrl: photoUrl } });
  if (count === 0) return { ok: false, error: "Заказ недоступен." };

  return { ok: true, photoUrl };
}
