"use server";
import { revalidatePath } from "next/cache";
import { requireFlorist } from "@/lib/rbac";
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
import { handoffOrder } from "@/modules/assignments/service";

// Заказ авто-принимается при назначении (см. assignAndActivateFlorist) — отдельного «Принять» больше нет.
//
// Ручной смены статуса у флориста нет: действия startWork/markReady/setReadyAt убраны как
// осиротевшие — кнопок, которые их вызывали, в интерфейсе не осталось.
// ВНИМАНИЕ: статусы IN_PROGRESS и READY после этого не выставляет НИЧТО. Они остаются в enum
// и в INTERNAL_WORKING_STATUSES (там они нужны для anti-rollback внешних обновлений), но
// заказ идёт ASSIGNED → … → DELIVERED мимо них. Если эти этапы понадобятся снова — это новая
// работа, а не восстановление удалённого.

/** Флорист передаёт свой заказ выбранному активному флористу (заменяет простой «Отказаться»). */
export async function floristHandoff(orderId: string, targetFloristId: string): Promise<{ ok: boolean; reason?: string }> {
  const user = await requireFlorist();
  if (!targetFloristId) return { ok: false, reason: "no_target" };
  const r = await handoffOrder(orderId, user.floristId, targetFloristId);
  revalidatePath("/dashboard/f");
  revalidatePath(`/dashboard/f/${orderId}`);
  return r;
}


