"use server";
/**
 * Создание ручного заказа — у владельца и у колл-центра (владелец 15.10.2026: «создавать заказ
 * кастомный вручную для Севинч»). Экран общий (`components/orders/manual`), логика — в
 * `manualOrder.ts`. Оператор денег флориста не задаёт: их ставит сервер по каталогу.
 */
import { requireRole } from "@/lib/rbac";
import {
  createManualOrder,
  withCatalogFloristPrices,
  ManualOrderError,
  type CreateManualOrderInput,
} from "@/modules/orders/manualOrder";

export async function createManualOrderAction(
  input: CreateManualOrderInput
): Promise<{ ok?: true; orderId?: string; orderNumber?: string; error?: string }> {
  const user = await requireRole("OWNER", "CALL_CENTER");
  try {
    const res = await createManualOrder(user.role === "OWNER" ? input : await withCatalogFloristPrices(input));
    return { ok: true, ...res };
  } catch (e) {
    if (e instanceof ManualOrderError) return { error: e.message };
    throw e;
  }
}
