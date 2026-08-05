import "server-only";
/**
 * Чтение раздела «Мои расходы»: месячная сводка по категориям и лента истории.
 *
 * Раздел отвечает на один вопрос — сколько ушло за месяц и на что. Никакой разбивки по
 * дням в интерфейсе нет; она осталась внутри как СЧЁТНЫЙ механизм (spread.ts) и нужна там,
 * где иначе месяц посчитался бы неверно: подписка должна сама появляться в каждом месяце,
 * а срок с 20 августа по 10 сентября — делиться между августом и сентябрём по реальным дням.
 *
 * Дневных строк в БД нет — есть правила (OwnerExpense). Поэтому правка суммы или срока
 * сразу меняет все месяцы, которых она касается: ни backfill, ни пересчёта.
 *
 * Выборка правил по окну намеренно широкая (всё, что МОЖЕТ пересечься), а отсечение —
 * в чистой функции: держать календарную арифметику в SQL значит дублировать её и потом
 * расходиться с тестами.
 */
import { prisma } from "@/lib/db";
import { allocateRule, isoDay, utcDay, type ExpenseKind, type ExpenseRule } from "./spread";

type RuleRow = {
  id: string; kind: string; amountCents: number; startDay: Date; endDay: Date | null;
  title: string | null;
  category: { id: string; name: string };
  subcategory: { id: string; name: string } | null;
};

const RULE_SELECT = {
  id: true, kind: true, amountCents: true, startDay: true, endDay: true, title: true,
  category: { select: { id: true, name: true } },
  subcategory: { select: { id: true, name: true } },
} as const;

/** Правила, которые могут пересечь окно: начались не позже конца и не кончились до начала. */
async function loadRules(from: Date, to: Date): Promise<RuleRow[]> {
  return prisma.ownerExpense.findMany({
    where: {
      startDay: { lte: to },
      OR: [{ endDay: null }, { endDay: { gte: from } }],
    },
    select: RULE_SELECT,
    orderBy: [{ startDay: "asc" }, { createdAt: "asc" }],
  });
}

const asRule = (r: RuleRow): ExpenseRule => ({
  id: r.id,
  kind: r.kind as ExpenseKind,
  amountCents: r.amountCents,
  startDay: r.startDay,
  endDay: r.endDay,
});

/** Одна запись расхода. Общая форма для месячной сводки и для ленты истории. */
export type ExpenseEntry = {
  id: string;
  /** Что показать человеку: своё название, иначе подкатегория, иначе категория. */
  label: string;
  categoryId: string;
  categoryName: string;
  subcategoryId: string | null;
  subcategoryName: string | null;
  title: string | null;
  kind: ExpenseKind;
  /** Исходная сумма правила. */
  amountCents: number;
  startDay: string;
  endDay: string | null;
};

/** Запись в месячной сводке: та же запись плюс её вклад ИМЕННО в этот месяц. */
export type MonthEntry = ExpenseEntry & { cents: number };

export type MonthCategory = {
  id: string;
  name: string;
  cents: number;
  entries: MonthEntry[];
};

export type ExpenseMonthSummary = {
  categories: MonthCategory[];
  totalCents: number;
};

function toEntry(r: RuleRow): ExpenseEntry {
  return {
    id: r.id,
    label: r.title?.trim() || r.subcategory?.name || r.category.name,
    categoryId: r.category.id,
    categoryName: r.category.name,
    subcategoryId: r.subcategory?.id ?? null,
    subcategoryName: r.subcategory?.name ?? null,
    title: r.title,
    kind: r.kind as ExpenseKind,
    amountCents: r.amountCents,
    startDay: isoDay(r.startDay),
    endDay: r.endDay ? isoDay(r.endDay) : null,
  };
}

/** Вклад правила в окно: сумма его дневных долей внутри периода. */
function centsInWindow(r: RuleRow, from: Date, to: Date): number {
  return allocateRule(asRule(r), from, to).reduce((a, p) => a + p.cents, 0);
}

/**
 * Месячная сводка: категории с суммами и записями внутри.
 *
 * Подкатегории отдельным уровнем НЕ выводятся: вложенность с отступами мешала читать
 * цифры, а имя подкатегории и так стоит в подписи записи. Внутри категории записи идут
 * от свежих к старым — так список отвечает на вопрос «когда я это платил».
 *
 * Пустые категории не показываются: список показывает траты, а не справочник.
 */
export async function getExpenseMonthSummary(from: Date, to: Date): Promise<ExpenseMonthSummary> {
  const rules = await loadRules(from, to);

  const byCategory = new Map<string, MonthCategory>();
  let totalCents = 0;

  for (const r of rules) {
    const cents = centsInWindow(r, from, to);
    if (cents === 0) continue; // правило есть, но в этот месяц не попало

    const cat = byCategory.get(r.category.id) ?? { id: r.category.id, name: r.category.name, cents: 0, entries: [] };
    cat.cents += cents;
    cat.entries.push({ ...toEntry(r), cents });
    byCategory.set(r.category.id, cat);
    totalCents += cents;
  }

  const categories = [...byCategory.values()]
    .map((c) => ({ ...c, entries: c.entries.sort((a, b) => b.startDay.localeCompare(a.startDay)) }))
    // Самые дорогие сверху: с этого вопроса на страницу и приходят.
    .sort((a, b) => b.cents - a.cents);

  return { categories, totalCents };
}

export type ExpenseHistoryPage = {
  entries: ExpenseEntry[];
  /** Сколько записей всего подходит под запрос — НЕ размер страницы. */
  total: number;
  page: number;
  perPage: number;
};

export const HISTORY_PER_PAGE = 50;

/**
 * Лента истории — записи за всё время, свежие сверху, страницами.
 *
 * Намеренно НЕ ограничена выбранным месяцем: она существует ровно ради вопросов «платил ли
 * я за домен месяц назад» и «когда последний раз платил OpenAI», а они по определению
 * выходят за границы одного месяца.
 *
 * Страницы, а не обрезка по лимиту: обрезанный список молча теряет старые записи, и counter
 * «всего N» показывал бы размер среза вместо настоящего количества — то есть врал бы ровно
 * в том месте, ради которого лента и заведена.
 */
export async function getExpenseHistory(
  query: string | null,
  page = 1,
  perPage = HISTORY_PER_PAGE
): Promise<ExpenseHistoryPage> {
  const q = (query ?? "").trim();
  const where = q
    ? {
        OR: [
          { title: { contains: q, mode: "insensitive" as const } },
          { category: { name: { contains: q, mode: "insensitive" as const } } },
          { subcategory: { name: { contains: q, mode: "insensitive" as const } } },
        ],
      }
    : {};

  const safePage = Math.max(1, Math.floor(page) || 1);
  const [rows, total] = await Promise.all([
    prisma.ownerExpense.findMany({
      where,
      select: RULE_SELECT,
      orderBy: [{ startDay: "desc" }, { createdAt: "desc" }],
      skip: (safePage - 1) * perPage,
      take: perPage,
    }),
    prisma.ownerExpense.count({ where }),
  ]);

  return { entries: rows.map(toEntry), total, page: safePage, perPage };
}

/** Сумма расходов за произвольное окно — для карточек «сегодня / месяц / год». */
export async function getExpenseTotal(from: Date, to: Date): Promise<number> {
  const rules = await loadRules(from, to);
  return rules.reduce((a, r) => a + centsInWindow(r, from, to), 0);
}

export type CategoryWithSubs = {
  id: string;
  name: string;
  isBuiltin: boolean;
  subcategories: { id: string; name: string }[];
};

/** Категории с подкатегориями — для формы расхода и экрана управления. */
export async function listExpenseCategories(): Promise<CategoryWithSubs[]> {
  return prisma.ownerExpenseCategory.findMany({
    where: { archivedAt: null },
    select: {
      id: true, name: true, isBuiltin: true,
      subcategories: {
        where: { archivedAt: null },
        select: { id: true, name: true },
        orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      },
    },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
  });
}

/** Первый день с данными — для списка годов в фильтре. */
export async function earliestExpenseDay(): Promise<Date | null> {
  const row = await prisma.ownerExpense.findFirst({ orderBy: { startDay: "asc" }, select: { startDay: true } });
  return row?.startDay ?? null;
}

export { utcDay, isoDay };
export type { ExpenseKind };
