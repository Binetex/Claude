"use server";
/**
 * Server actions дополнительных расходов заказа.
 *
 * Один файл на все три роли: владелец, колл-центр и флорист вносят расход одинаково, а
 * различает их не действие, а доступ к заказу — он проверяется внутри модуля тем же
 * правилом, что и сама карточка (флорист только свой заказ). Заводить три копии значило бы
 * три места, где это правило можно разойтись.
 */
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/rbac";
import {
  addOrderExpense,
  removeOrderExpense,
  updateOrderExpense,
  OrderExpenseError,
} from "@/modules/finance/orderExpenses";

export type OrderExpenseActionResult = { error?: string; message?: string };

function fail(e: unknown): OrderExpenseActionResult {
  if (e instanceof OrderExpenseError) return { error: e.message };
  throw e;
}

function parseAmountCents(raw: FormDataEntryValue | null): number {
  const text = String(raw ?? "").trim().replace(",", ".");
  if (!text) throw new OrderExpenseError("bad_amount", "Введите сумму.");
  const value = Number(text);
  if (!Number.isFinite(value) || value <= 0) {
    throw new OrderExpenseError("bad_amount", "Сумма расхода должна быть больше нуля.");
  }
  return Math.round(value * 100);
}

function parseDay(raw: FormDataEntryValue | null): Date {
  const v = String(raw ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new OrderExpenseError("bad_day", "Дата должна быть в формате ГГГГ-ММ-ДД.");
  return new Date(`${v}T00:00:00.000Z`);
}

/** Пути, где сумма расхода видна: карточки заказа всех ролей и финансовые экраны. */
function refresh(orderId: string): void {
  revalidatePath(`/dashboard/orders/${orderId}`);
  revalidatePath(`/dashboard/cc/${orderId}`);
  revalidatePath(`/dashboard/f/${orderId}`);
  revalidatePath("/dashboard/finance/share");
  revalidatePath("/dashboard/finance/florists");
  revalidatePath("/dashboard/f/finance");
}

function describe(effect: { kind: string; share?: string; day?: string }): string {
  if (effect.kind === "PRIMARY_DAY") {
    return effect.share === "CORRECTED"
      ? ` Доля за ${effect.day} пересчитана.`
      : effect.share === "UNCHANGED"
        ? " Доля за день не изменилась."
        : "";
  }
  if (effect.kind === "SECONDARY_DEDUCTION") return " Удержание отражено в балансе флориста.";
  return "";
}

export async function addOrderExpenseAction(formData: FormData): Promise<OrderExpenseActionResult> {
  const user = await requireUser();
  const orderId = String(formData.get("orderId") ?? "");
  try {
    const r = await addOrderExpense({
      orderId,
      amountCents: parseAmountCents(formData.get("amount")),
      description: String(formData.get("description") ?? ""),
      expenseDate: parseDay(formData.get("expenseDate")),
      actor: { userId: user.id, role: user.role, floristId: user.floristId },
    });
    refresh(orderId);
    return { message: `Расход добавлен.${describe(r.effect)}` };
  } catch (e) {
    return fail(e);
  }
}

export async function updateOrderExpenseAction(formData: FormData): Promise<OrderExpenseActionResult> {
  const user = await requireUser();
  const orderId = String(formData.get("orderId") ?? "");
  try {
    const r = await updateOrderExpense({
      expenseId: String(formData.get("expenseId") ?? ""),
      amountCents: parseAmountCents(formData.get("amount")),
      description: String(formData.get("description") ?? ""),
      expenseDate: parseDay(formData.get("expenseDate")),
      reason: String(formData.get("reason") ?? "") || null,
      actor: { userId: user.id, role: user.role, floristId: user.floristId },
    });
    refresh(orderId);
    return {
      message:
        r.action === "REPLACED"
          ? `Прежний расход отменён, создан исправленный.${describe(r.effect)}`
          : `Расход изменён.${describe(r.effect)}`,
    };
  } catch (e) {
    return fail(e);
  }
}

export async function removeOrderExpenseAction(formData: FormData): Promise<OrderExpenseActionResult> {
  const user = await requireUser();
  const orderId = String(formData.get("orderId") ?? "");
  try {
    const r = await removeOrderExpense({
      expenseId: String(formData.get("expenseId") ?? ""),
      reason: String(formData.get("reason") ?? ""),
      actor: { userId: user.id, role: user.role, floristId: user.floristId },
    });
    refresh(orderId);
    return {
      message: r.action === "REVERSED" ? `Расход отменён.${describe(r.effect)}` : `Расход удалён.${describe(r.effect)}`,
    };
  } catch (e) {
    return fail(e);
  }
}
