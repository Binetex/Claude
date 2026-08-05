"use server";
/**
 * Server actions раздела «Мои расходы». Тонкие обёртки: вся логика — в modules/expenses.
 * Роль проверяется здесь, автор берётся из сессии и из формы не принимается.
 */
import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/rbac";
import { ExpenseError, saveExpense, deleteExpense } from "@/modules/expenses/write";

export type ExpenseActionResult = { error?: string; message?: string };

function fail(e: unknown): ExpenseActionResult {
  if (e instanceof ExpenseError) return { error: e.message };
  throw e;
}

/**
 * Правило влияет на много дней сразу, поэтому обновляем весь раздел, а не одну дату.
 *
 * Финансовый дашборд обновляем тоже: мои расходы входят в прибыль владельца, и без этого
 * он показывал бы прежнюю цифру до истечения клиентского кэша — а выглядело бы это как
 * «добавил расход, прибыль не изменилась, система сломалась».
 */
function refresh(): void {
  revalidatePath("/dashboard/expenses", "layout");
  revalidatePath("/dashboard/finance", "layout");
}

export async function saveExpenseAction(fd: FormData): Promise<ExpenseActionResult> {
  const user = await requireRole("OWNER");
  try {
    const rawCategory = String(fd.get("categoryId") ?? "");
    const newName = String(fd.get("newCategoryName") ?? "").trim();
    const rawSub = String(fd.get("subcategoryId") ?? "");
    await saveExpense(
      {
        id: String(fd.get("id") ?? "") || null,
        // «+ Новая категория…» — не идентификатор: подставлять его в БД нельзя.
        categoryId: rawCategory === "__new__" ? "" : rawCategory,
        newCategoryName: rawCategory === "__new__" ? newName : null,
        // «+ Новая подкатегория…» — тоже не идентификатор, в БД его класть нельзя.
        subcategoryId: rawSub === "__new_sub__" ? null : rawSub || null,
        newSubcategoryName: rawSub === "__new_sub__" ? String(fd.get("newSubcategoryName") ?? "").trim() : null,
        title: String(fd.get("title") ?? ""),
        amountRaw: String(fd.get("amount") ?? ""),
        kind: String(fd.get("kind") ?? ""),
        startDayRaw: String(fd.get("startDay") ?? ""),
        endDayRaw: String(fd.get("endDay") ?? ""),
      },
      user.id
    );
    refresh();
    return { message: "Расход сохранён" };
  } catch (e) {
    return fail(e);
  }
}

export async function deleteExpenseAction(fd: FormData): Promise<ExpenseActionResult> {
  await requireRole("OWNER");
  try {
    const id = String(fd.get("id") ?? "");
    if (!id) throw new ExpenseError("Расход не указан.");
    await deleteExpense(id);
    refresh();
    return { message: "Расход удалён" };
  } catch (e) {
    return fail(e);
  }
}
