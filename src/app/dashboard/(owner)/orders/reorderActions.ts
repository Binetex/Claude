"use server";
/**
 * Стрелки очереди дня. Право на перестановку — у владельца и колл-центра: день ведут они,
 * флорист только исполняет и свой порядок не меняет.
 */
import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/rbac";
import { prisma } from "@/lib/db";
import { moveOrderInDay, type ReorderResult } from "@/modules/orders/reorder";

export async function moveOrderAction(
  orderId: string,
  direction: "up" | "down",
  visibleIds: string[]
): Promise<ReorderResult> {
  await requireRole("OWNER", "CALL_CENTER");
  const res = await moveOrderInDay(prisma, { orderId, direction, visibleIds });
  if (res.error) return res;
  // Очередь одна на день, но смотрят на неё из трёх кабинетов: владелец переставил — флорист
  // обязан увидеть новый порядок, не дожидаясь, пока страница протухнет сама.
  for (const p of ["/dashboard/orders", "/dashboard/cc", "/dashboard/f"]) revalidatePath(p);
  return res;
}
