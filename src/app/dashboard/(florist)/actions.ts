"use server";
import { revalidatePath } from "next/cache";
import { requireFlorist } from "@/lib/rbac";
import { imageStorage } from "@/lib/storage";
import { floristSetCardMessage } from "@/modules/print/cardEdit";
import { CARD_MESSAGE_MAX } from "@/lib/print/cardText";

/**
 * Флорист редактирует ТЕКСТ ОТКРЫТКИ (cardMessage) назначенного ему заказа. Меняет только
 * cardMessage; ничего не отправляет во внешний магазин и не запускает sync/webhook/SMS/Burq.
 * Чужой/несуществующий заказ → одинаковая ошибка (не раскрываем причину).
 */
export async function floristUpdateCardMessage(
  orderId: string,
  cardMessage: string
): Promise<{ ok?: boolean; error?: string; message?: string }> {
  const user = await requireFlorist();
  if (typeof cardMessage !== "string") return { error: "Некорректный текст." };
  if (cardMessage.length > CARD_MESSAGE_MAX + 1000) return { error: `Текст слишком длинный (максимум ${CARD_MESSAGE_MAX} символов).` };
  const { ok } = await floristSetCardMessage(orderId, user.floristId, cardMessage);
  if (!ok) return { error: "Заказ недоступен." };
  revalidatePath("/dashboard/f");
  revalidatePath(`/dashboard/f/${orderId}`);
  revalidatePath("/dashboard/f/print-notes");
  return { ok: true, message: "Текст открытки сохранён." };
}
import {
  acceptOrder,
  declineOrder,
  startWork,
  markReady,
  setReadyAt,
} from "@/modules/assignments/service";

export async function floristAccept(orderId: string) {
  const user = await requireFlorist();
  await acceptOrder(orderId, user.floristId);
  revalidatePath("/dashboard/f");
  revalidatePath(`/dashboard/f/${orderId}`);
}

export async function floristDecline(orderId: string) {
  const user = await requireFlorist();
  await declineOrder(orderId, user.floristId);
  revalidatePath("/dashboard/f");
  revalidatePath(`/dashboard/f/${orderId}`);
}

export async function floristStartWork(orderId: string) {
  const user = await requireFlorist();
  await startWork(orderId, user.floristId);
  revalidatePath("/dashboard/f");
  revalidatePath(`/dashboard/f/${orderId}`);
}

export async function floristSetReadyTime(orderId: string, isoTime: string) {
  const user = await requireFlorist();
  await setReadyAt(orderId, user.floristId, new Date(isoTime));
  revalidatePath(`/dashboard/f/${orderId}`);
}

export async function floristMarkReady(orderId: string, photoDataUrl?: string) {
  const user = await requireFlorist();
  let photoUrl: string | undefined;
  if (photoDataUrl) {
    try {
      photoUrl = await imageStorage.saveImage(photoDataUrl);
    } catch (err) {
      // Фото не обязательно для статуса "Готов" — не блокируем флориста из-за сбоя
      // хранилища (например, временная проблема с диском), просто логируем и продолжаем без фото.
      console.error(`[florist] не удалось сохранить фото букета для заказа ${orderId}:`, err);
    }
  }
  await markReady(orderId, user.floristId, photoUrl);
  revalidatePath("/dashboard/f");
  revalidatePath(`/dashboard/f/${orderId}`);
}
