"use server";
/**
 * Server actions раздела «Расходы на цветы» у владельца.
 *
 * Тонкие обёртки: вся логика — в modules/finance/flowerExpenses. Роль проверяется здесь,
 * профиль резолвится внутри модуля из актора, поэтому financeProfileId из формы не
 * принимается ни в одном действии.
 */
import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/rbac";
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

/** Рубли-с-копейками из формы в целые центы. Пустое поле — не ноль, а ошибка. */
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

/**
 * Закупка меняет итог дня, а он виден сразу в трёх местах: расходы в кабинете флориста у
 * владельца, заработок в кабинете самого флориста и очередь «Требует заполнения».
 * Кабинет владельца лежит под [floristId], поэтому обновляем поддерево целиком.
 */
function refresh(): void {
  revalidatePath("/dashboard/finance/florists", "layout");
  revalidatePath("/dashboard/f/finance");
  revalidatePath("/dashboard/finance/setup");
}

export async function saveExpenseAction(formData: FormData): Promise<ExpenseActionResult> {
  const user = await requireRole("OWNER");
  try {
    const r = await saveFlowerExpense({
      actor: { userId: user.id, role: user.role },
      expenseDay: parseDay(String(formData.get("day") ?? "")),
      amountCents: parseAmountCents(formData.get("amount")),
      comment: String(formData.get("comment") ?? "").trim() || null,
    });
    refresh();
    return {
      message: r.shareCents != null
        ? `Расход за ${r.day} сохранён. Заработок флориста за день: ${(r.shareCents / 100).toFixed(2)}.`
        : `Расход за ${r.day} сохранён. День пока не посчитан целиком.`,
    };
  } catch (e) {
    return fail(e);
  }
}

export async function deleteExpenseAction(formData: FormData): Promise<ExpenseActionResult> {
  const user = await requireRole("OWNER");
  try {
    const r = await deleteFlowerExpense({
      actor: { userId: user.id, role: user.role },
      expenseDay: parseDay(String(formData.get("day") ?? "")),
      reason: String(formData.get("reason") ?? ""),
    });
    refresh();
    return { message: `Расход за ${r.day} удалён, день пересчитан.` };
  } catch (e) {
    return fail(e);
  }
}

/** Предпросмотр: ничего не пишет, нужен до подтверждения правки или удаления. */
export async function previewExpenseAction(
  day: string,
  amount: string | null
): Promise<{ error?: string; preview?: ExpensePreview }> {
  const user = await requireRole("OWNER");
  try {
    const profile = await resolveProfileFor({ userId: user.id, role: user.role });
    if (!profile) return { error: "Нет действующего профиля основного флориста." };
    const nextCents = amount == null ? null : parseAmountCents(amount);
    return { preview: await previewFlowerExpense(profile.id, parseDay(day), nextCents) };
  } catch (e) {
    const r = fail(e);
    return { error: r.error };
  }
}
