import Link from "next/link";
import { requireRole } from "@/lib/rbac";
import { PageHeader } from "@/components/ui/misc";
import { Button } from "@/components/ui/button";
import { CategoryManager } from "@/components/expenses/CategoryManager";
import { listExpenseCategories } from "@/modules/expenses/read";
import {
  createCategoryAction, renameCategoryAction, archiveCategoryAction,
  createSubcategoryAction, renameSubcategoryAction, archiveSubcategoryAction,
} from "./actions";

export const dynamic = "force-dynamic";

/** Справочник, по которому раскладываются расходы в сводке. */
export default async function ExpenseCategoriesPage() {
  await requireRole("OWNER");
  const categories = await listExpenseCategories();

  return (
    <div className="space-y-4">
      <PageHeader
        title="Категории расходов"
        description="Категории и подкатегории, по которым раскладываются расходы в месячной сводке."
        actions={
          <Button asChild variant="outline">
            <Link href="/dashboard/expenses">К расходам</Link>
          </Button>
        }
      />

      <CategoryManager
        categories={categories}
        actions={{
          create: createCategoryAction,
          rename: renameCategoryAction,
          archive: archiveCategoryAction,
          createSub: createSubcategoryAction,
          renameSub: renameSubcategoryAction,
          archiveSub: archiveSubcategoryAction,
        }}
      />

      <p className="text-xs text-slate-400">
        Категории и подкатегории не удаляются, а убираются из списка: на них ссылаются уже внесённые расходы, и их
        история должна остаться читаемой. Прошлые расходы убранной категории продолжают считаться в сводке.
      </p>
    </div>
  );
}
