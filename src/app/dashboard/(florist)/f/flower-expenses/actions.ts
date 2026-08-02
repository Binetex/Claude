"use server";
/**
 * Server actions расходов на цветы в кабинете основного флориста.
 *
 * Отдельный файл от владельческого СОЗНАТЕЛЬНО: guard здесь свой (requireFlorist), и
 * увидеть, чем защищён каждый путь, можно не разбирая ветвления внутри общей функции.
 *
 * floristId берётся из сессии, financeProfileId резолвится по нему внутри модуля и только
 * среди активных PRIMARY-профилей. Из формы не принимается ни то, ни другое, поэтому
 * подставить чужой профиль нечем — не «проверяется», а физически неоткуда взять.
 */
import { revalidatePath } from "next/cache";
import { requireFlorist } from "@/lib/rbac";
import {
  deleteFlowerExpense,
  parseDay,
  previewFlowerExpense,
  resolveProfileFor,
  saveFlowerExpense,
  FlowerExpenseError,
  type ExpensePreview,
} from "@/modules/finance/flowerExpenses";

export type ExpenseActionResult = { error?: string; message?: string };

function parseAmountCents(raw: FormDataEntryValue | null): number {
  const text = String(raw ?? "").trim().replace(",", ".");
  if (!text) throw new FlowerExpenseError("bad_amount", "Введите сумму.");
  const value = Number(text);
  if (!Number.isFinite(value) || value < 0) throw new FlowerExpenseError("bad_amount", "Сумма должна быть неотрицательным числом.");
  return Math.round(value * 100);
}

function fail(e: unknown): ExpenseActionResult {
  if (e instanceof FlowerExpenseError) return { error: e.message };
  throw e;
}

export async function saveMyExpenseAction(formData: FormData): Promise<ExpenseActionResult> {
  const user = await requireFlorist();
  try {
    const r = await saveFlowerExpense({
      actor: { userId: user.id, role: user.role, floristId: user.floristId },
      expenseDay: parseDay(String(formData.get("day") ?? "")),
      amountCents: parseAmountCents(formData.get("amount")),
      comment: String(formData.get("comment") ?? "").trim() || null,
    });
    revalidatePath("/dashboard/f/flower-expenses");
    revalidatePath("/dashboard/f/finance");
    return { message: `Расход за ${r.day} сохранён.` };
  } catch (e) {
    return fail(e);
  }
}

export async function deleteMyExpenseAction(formData: FormData): Promise<ExpenseActionResult> {
  const user = await requireFlorist();
  try {
    const r = await deleteFlowerExpense({
      actor: { userId: user.id, role: user.role, floristId: user.floristId },
      expenseDay: parseDay(String(formData.get("day") ?? "")),
      reason: String(formData.get("reason") ?? ""),
    });
    revalidatePath("/dashboard/f/flower-expenses");
    revalidatePath("/dashboard/f/finance");
    return {
      message: r.reversedCents
        ? `Расход за ${r.day} удалён, начисление ${(r.reversedCents / 100).toFixed(2)} сторновано.`
        : `Расход за ${r.day} удалён.`,
    };
  } catch (e) {
    return fail(e);
  }
}

export async function previewMyExpenseAction(
  day: string,
  amount: string | null
): Promise<{ error?: string; preview?: ExpensePreview }> {
  const user = await requireFlorist();
  try {
    const profile = await resolveProfileFor({ userId: user.id, role: user.role, floristId: user.floristId });
    if (!profile) return { error: "Раздел доступен только основному флористу." };
    const nextCents = amount == null ? null : parseAmountCents(amount);
    return { preview: await previewFlowerExpense(profile.id, parseDay(day), nextCents) };
  } catch (e) {
    const r = fail(e);
    return { error: r.error };
  }
}
