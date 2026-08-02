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

function refresh(): void {
  revalidatePath("/dashboard/finance/flower-expenses");
  revalidatePath("/dashboard/finance/share");
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
    const share =
      r.share.status === "CORRECTED"
        ? ` Начисление пересчитано: было ${(r.share.fromCents! / 100).toFixed(2)}, стало ${(r.share.toCents! / 100).toFixed(2)}.`
        : r.share.status === "CREATED"
          ? " Начисление за день создано."
          : "";
    return { message: `Расход за ${r.day} сохранён. Ревизий снимков: ${r.republished}.${share}` };
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
    return {
      message: r.reversedCents
        ? `Расход за ${r.day} удалён, начисление ${(r.reversedCents / 100).toFixed(2)} сторновано.`
        : `Расход за ${r.day} удалён.`,
    };
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
