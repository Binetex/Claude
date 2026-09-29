"use server";
/**
 * Серверные действия формы ручного заказа. Тонкие обёртки: вся логика — в
 * modules/orders/manualOrder, роль проверяется здесь.
 */
import { requireRole } from "@/lib/rbac";
import { createManualOrder, ManualOrderError, type CreateManualOrderInput } from "@/modules/orders/manualOrder";

export async function ownerCreateManualOrder(
  input: CreateManualOrderInput
): Promise<{ ok?: true; orderId?: string; orderNumber?: string; error?: string }> {
  await requireRole("OWNER");
  try {
    const res = await createManualOrder(input);
    return { ok: true, ...res };
  } catch (e) {
    if (e instanceof ManualOrderError) return { error: e.message };
    throw e;
  }
}
