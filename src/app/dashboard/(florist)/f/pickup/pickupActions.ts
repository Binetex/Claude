"use server";
import { revalidatePath } from "next/cache";
import { requireFlorist } from "@/lib/rbac";
import { prisma } from "@/lib/db";
import { setPrimaryPickupLocation } from "@/modules/pickup/service";
import { setPrimaryFormState, type PickupFormState } from "@/modules/pickup/messages";

/**
 * Флорист выбирает СВОЮ основную точку забора. Адреса точек заводит владелец — флорист
 * только указывает, откуда он работает сейчас.
 *
 * Действует на будущие заказы: уже созданные Burq-доставки не трогаются (см. modules/pickup/service).
 * Поменять точку конкретного заказа можно на странице этого заказа.
 */
export async function floristSetPrimaryPickupLocation(_prev: PickupFormState, formData: FormData): Promise<PickupFormState> {
  const user = await requireFlorist();
  const id = String(formData.get("id") ?? "");
  if (!id) return { error: "Не указана точка." };

  // floristId берём из сессии, а не из формы: чужую точку сделать основной нельзя.
  const res = await setPrimaryPickupLocation(prisma, { locationId: id, floristId: user.floristId });
  revalidatePath("/dashboard/f/pickup");
  return setPrimaryFormState(res);
}
