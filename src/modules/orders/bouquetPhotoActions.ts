"use server";
/**
 * Загрузка фото букета — общее действие для всех, кто ведёт заказ: флориста, колл-центра и
 * владельца. Лежит в модуле, а не рядом со страницей, потому что страниц три.
 */
import { revalidatePath } from "next/cache";
import { requireOrderEditor } from "@/lib/rbac";
import { saveBouquetPhoto } from "./bouquetPhoto";

export type UploadBouquetPhotoResult = { ok?: true; error?: string };

export async function uploadBouquetPhotoAction(orderId: string, photoDataUrl: string): Promise<UploadBouquetPhotoResult> {
  const user = await requireOrderEditor();
  const res = await saveBouquetPhoto(orderId, photoDataUrl, { role: user.role, floristId: user.floristId });
  if (!res.ok) return { error: res.error };

  // Карточка заказа открыта в трёх кабинетах — обновляем все: фото одно на заказ.
  revalidatePath(`/dashboard/f/${orderId}`);
  revalidatePath(`/dashboard/cc/${orderId}`);
  revalidatePath(`/dashboard/orders/${orderId}`);
  return { ok: true };
}
