"use server";
/**
 * Server actions управления категориями расходов. Тонкие обёртки: логика — в modules/expenses.
 */
import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/rbac";
import {
  ExpenseError, createCategory, renameCategory, archiveCategory,
  createSubcategory, renameSubcategory, archiveSubcategory,
} from "@/modules/expenses/write";

export type CategoryActionResult = { error?: string; message?: string };

function fail(e: unknown): CategoryActionResult {
  if (e instanceof ExpenseError) return { error: e.message };
  throw e;
}

/** Категории видны в сводке, поэтому обновляем весь раздел. */
function refresh(): void {
  revalidatePath("/dashboard/expenses", "layout");
}

async function run(fn: () => Promise<void>, message: string): Promise<CategoryActionResult> {
  await requireRole("OWNER");
  try {
    await fn();
    refresh();
    return { message };
  } catch (e) {
    return fail(e);
  }
}

export async function createCategoryAction(fd: FormData): Promise<CategoryActionResult> {
  return run(() => createCategory(String(fd.get("name") ?? "")), "Категория добавлена");
}

export async function renameCategoryAction(fd: FormData): Promise<CategoryActionResult> {
  return run(() => renameCategory(String(fd.get("id") ?? ""), String(fd.get("name") ?? "")), "Переименовано");
}

export async function archiveCategoryAction(fd: FormData): Promise<CategoryActionResult> {
  return run(() => archiveCategory(String(fd.get("id") ?? "")), "Категория убрана из списка");
}

export async function createSubcategoryAction(fd: FormData): Promise<CategoryActionResult> {
  return run(
    () => createSubcategory(String(fd.get("categoryId") ?? ""), String(fd.get("name") ?? "")),
    "Подкатегория добавлена"
  );
}

export async function renameSubcategoryAction(fd: FormData): Promise<CategoryActionResult> {
  return run(() => renameSubcategory(String(fd.get("id") ?? ""), String(fd.get("name") ?? "")), "Переименовано");
}

export async function archiveSubcategoryAction(fd: FormData): Promise<CategoryActionResult> {
  return run(() => archiveSubcategory(String(fd.get("id") ?? "")), "Подкатегория убрана");
}
