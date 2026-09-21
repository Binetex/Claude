"use server";
/**
 * Сохранение очереди дня. Право — у владельца и колл-центра: день ведут они, флорист только
 * исполняет и свой порядок не меняет.
 */
import { requireRole } from "@/lib/rbac";
import { prisma } from "@/lib/db";
import { saveDayQueue, type ReorderResult } from "@/modules/orders/reorder";

export async function saveDayQueueAction(orderIds: string[]): Promise<ReorderResult> {
  await requireRole("OWNER", "CALL_CENTER");
  // revalidatePath здесь НЕТ намеренно. Экран у того, кто переставлял, уже показывает новый
  // порядок — он его и задал; пересборка страницы означала бы моргание списка на каждое
  // сохранение ради данных, которые и так верны. Остальные кабинеты рисуются force-dynamic и
  // читают порядок заново при каждом открытии.
  return saveDayQueue(prisma, orderIds);
}
