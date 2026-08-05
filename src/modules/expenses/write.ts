import "server-only";
/**
 * Изменение расходов владельца. Правила простые, потому что и модель простая: одна строка
 * на расход, никаких проводок и сторно. Ошибки — свой тип, чтобы server action показал
 * их человеку, а не уронил страницу.
 */
import { prisma } from "@/lib/db";
import { utcDay, type ExpenseKind } from "./spread";

export class ExpenseError extends Error {}

const KINDS: ExpenseKind[] = ["ONE_OFF", "DAILY", "MONTHLY", "RANGE"];

export function parseDay(raw: string | null | undefined, field = "Дата"): Date {
  const v = String(raw ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new ExpenseError(`${field}: укажите дату.`);
  const d = utcDay(v);
  if (Number.isNaN(d.getTime())) throw new ExpenseError(`${field}: некорректная дата.`);
  return d;
}

/** Сумма из формы в целые центы. Пустое поле — ошибка, а не ноль. */
export function parseAmountCents(raw: string | null | undefined): number {
  const text = String(raw ?? "").trim().replace(",", ".");
  if (!text) throw new ExpenseError("Введите сумму.");
  const value = Number(text);
  if (!Number.isFinite(value) || value < 0) throw new ExpenseError("Сумма должна быть неотрицательным числом.");
  return Math.round(value * 100);
}

export type SaveExpenseInput = {
  id?: string | null;
  categoryId: string;
  /** Новая категория вместо выбора из списка — создаётся на лету. */
  newCategoryName?: string | null;
  /** Пусто — расход отнесён прямо к категории, без второго уровня. */
  subcategoryId?: string | null;
  /** Новая подкатегория внутри выбранной категории. */
  newSubcategoryName?: string | null;
  title?: string | null;
  amountRaw: string | null;
  kind: string;
  startDayRaw: string | null;
  endDayRaw?: string | null;
};

/**
 * Создаёт или правит расход.
 *
 * Срок проверяется по виду: у ONE_OFF его нет вовсе, у RANGE он обязателен (иначе делить
 * не на что), у DAILY/MONTHLY — необязателен, пустой конец означает «пока не отменю».
 */
export async function saveExpense(input: SaveExpenseInput, actorId: string): Promise<{ id: string }> {
  const kind = String(input.kind) as ExpenseKind;
  if (!KINDS.includes(kind)) throw new ExpenseError("Выберите срок расхода.");

  const amountCents = parseAmountCents(input.amountRaw);
  const startDay = parseDay(input.startDayRaw, "Дата начала");

  let endDay: Date | null = null;
  if (kind === "RANGE") {
    endDay = parseDay(input.endDayRaw, "Дата окончания");
    if (endDay < startDay) throw new ExpenseError("Окончание не может быть раньше начала.");
  } else if (kind !== "ONE_OFF" && String(input.endDayRaw ?? "").trim()) {
    endDay = parseDay(input.endDayRaw, "Дата окончания");
    if (endDay < startDay) throw new ExpenseError("Окончание не может быть раньше начала.");
  }

  const categoryId = await resolveCategory(input.categoryId, input.newCategoryName);
  const subcategoryId = await resolveSubcategory(categoryId, input.subcategoryId, input.newSubcategoryName);
  const title = String(input.title ?? "").trim() || null;

  if (input.id) {
    const existing = await prisma.ownerExpense.findUnique({ where: { id: input.id }, select: { id: true } });
    if (!existing) throw new ExpenseError("Расход не найден — возможно, его уже удалили.");
    await prisma.ownerExpense.update({
      where: { id: input.id },
      data: { categoryId, subcategoryId, title, amountCents, kind, startDay, endDay, updatedBy: actorId },
    });
    return { id: input.id };
  }

  const created = await prisma.ownerExpense.create({
    data: { categoryId, subcategoryId, title, amountCents, kind, startDay, endDay, createdBy: actorId },
    select: { id: true },
  });
  return created;
}

/**
 * Категория: либо выбранная из списка, либо новая по имени. Совпадение по имени
 * переиспользует существующую — две «Реклама» в списке владельцу не нужны.
 */
async function resolveCategory(categoryId: string, newName: string | null | undefined): Promise<string> {
  const name = String(newName ?? "").trim();
  if (name) {
    const existing = await prisma.ownerExpenseCategory.findUnique({ where: { name }, select: { id: true, archivedAt: true } });
    if (existing) {
      if (existing.archivedAt) {
        await prisma.ownerExpenseCategory.update({ where: { id: existing.id }, data: { archivedAt: null } });
      }
      return existing.id;
    }
    const created = await prisma.ownerExpenseCategory.create({
      data: { name, isBuiltin: false },
      select: { id: true },
    });
    return created.id;
  }

  const id = String(categoryId ?? "").trim();
  if (!id) throw new ExpenseError("Выберите категорию или введите новую.");
  const found = await prisma.ownerExpenseCategory.findUnique({ where: { id }, select: { id: true } });
  if (!found) throw new ExpenseError("Категория не найдена.");
  return found.id;
}

export async function deleteExpense(id: string): Promise<void> {
  const existing = await prisma.ownerExpense.findUnique({ where: { id }, select: { id: true } });
  if (!existing) return; // уже удалён — повторный клик не должен ругаться
  await prisma.ownerExpense.delete({ where: { id } });
}

/**
 * Подкатегория: выбранная, новая по имени либо её отсутствие. Проверяется принадлежность
 * категории — подкатегория «OpenAI» из «Подписок» не должна оказаться у «Хостинга»,
 * а сменить категорию в форме можно в любой момент.
 */
async function resolveSubcategory(
  categoryId: string,
  subcategoryId: string | null | undefined,
  newName: string | null | undefined
): Promise<string | null> {
  const name = String(newName ?? "").trim();
  if (name) {
    const existing = await prisma.ownerExpenseSubcategory.findUnique({
      where: { categoryId_name: { categoryId, name } },
      select: { id: true, archivedAt: true },
    });
    if (existing) {
      if (existing.archivedAt) {
        await prisma.ownerExpenseSubcategory.update({ where: { id: existing.id }, data: { archivedAt: null } });
      }
      return existing.id;
    }
    const created = await prisma.ownerExpenseSubcategory.create({
      data: { categoryId, name },
      select: { id: true },
    });
    return created.id;
  }

  const id = String(subcategoryId ?? "").trim();
  if (!id) return null;
  const found = await prisma.ownerExpenseSubcategory.findUnique({ where: { id }, select: { id: true, categoryId: true } });
  // Категорию сменили, а подкатегория осталась от прежней — тихо отвязываем, а не роняем
  // форму: пользователь про эту связь не думает.
  if (!found || found.categoryId !== categoryId) return null;
  return found.id;
}

/** Создать категорию с экрана управления. */
export async function createCategory(name: string): Promise<void> {
  const clean = name.trim();
  if (!clean) throw new ExpenseError("Введите название категории.");
  const existing = await prisma.ownerExpenseCategory.findUnique({ where: { name: clean }, select: { id: true } });
  if (existing) throw new ExpenseError("Категория с таким названием уже есть.");
  await prisma.ownerExpenseCategory.create({ data: { name: clean } });
}

export async function renameCategory(id: string, name: string): Promise<void> {
  const clean = name.trim();
  if (!clean) throw new ExpenseError("Название не может быть пустым.");
  const clash = await prisma.ownerExpenseCategory.findUnique({ where: { name: clean }, select: { id: true } });
  if (clash && clash.id !== id) throw new ExpenseError("Категория с таким названием уже есть.");
  await prisma.ownerExpenseCategory.update({ where: { id }, data: { name: clean } });
}

/**
 * Убрать категорию из списка. Не удаляем: на неё ссылаются расходы, и их история должна
 * остаться читаемой. Архивная категория не предлагается в форме, но её прошлые расходы
 * продолжают считаться и показываться в сводке.
 */
export async function archiveCategory(id: string): Promise<void> {
  const cat = await prisma.ownerExpenseCategory.findUnique({ where: { id }, select: { isBuiltin: true } });
  if (!cat) return;
  if (cat.isBuiltin) throw new ExpenseError("Встроенную категорию убрать нельзя.");
  await prisma.ownerExpenseCategory.update({ where: { id }, data: { archivedAt: new Date() } });
}

export async function createSubcategory(categoryId: string, name: string): Promise<void> {
  const clean = name.trim();
  if (!clean) throw new ExpenseError("Введите название подкатегории.");
  const existing = await prisma.ownerExpenseSubcategory.findUnique({
    where: { categoryId_name: { categoryId, name: clean } },
    select: { id: true, archivedAt: true },
  });
  if (existing) {
    if (!existing.archivedAt) throw new ExpenseError("Такая подкатегория уже есть.");
    await prisma.ownerExpenseSubcategory.update({ where: { id: existing.id }, data: { archivedAt: null } });
    return;
  }
  await prisma.ownerExpenseSubcategory.create({ data: { categoryId, name: clean } });
}

export async function renameSubcategory(id: string, name: string): Promise<void> {
  const clean = name.trim();
  if (!clean) throw new ExpenseError("Название не может быть пустым.");
  await prisma.ownerExpenseSubcategory.update({ where: { id }, data: { name: clean } });
}

/** Расходы сохраняют ссылку: подкатегория просто перестаёт предлагаться в форме. */
export async function archiveSubcategory(id: string): Promise<void> {
  await prisma.ownerExpenseSubcategory.update({ where: { id }, data: { archivedAt: new Date() } });
}
