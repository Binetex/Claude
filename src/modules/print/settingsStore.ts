import "server-only";
/**
 * Чтение и запись настроек печати. Вся арифметика — в соседнем `settings.ts`, здесь только
 * БД: модуль настроек обязан оставаться чистым, его читает и клиентский компонент печати.
 *
 * Строки в таблице может не быть — это НЕ ошибка, а «печатаем по умолчанию». Поэтому
 * заранее её никто не создаёт: печать работает и до первого захода владельца в настройки.
 */
import { prisma } from "@/lib/db";
import {
  PRINT_DEFAULTS,
  PRINT_FIELDS,
  clampSettings,
  kindToLayout,
  layoutToKind,
  type PrintLayout,
  type PrintSettings,
} from "./settings";

type Row = { [K in keyof PrintSettings]: number };

const pick = (row: Row): PrintSettings =>
  Object.fromEntries(PRINT_FIELDS.map((k) => [k, row[k]])) as PrintSettings;

/** Настройки одной раскладки. Нет строки — значения по умолчанию. */
export async function loadPrintSettings(layout: PrintLayout): Promise<PrintSettings> {
  const row = await prisma.printLayoutSettings.findUnique({ where: { layout: layoutToKind(layout) } });
  return clampSettings(layout, row ? pick(row) : PRINT_DEFAULTS[layout]);
}

/** Настройки обеих раскладок — для страницы владельца. */
export async function loadAllPrintSettings(): Promise<Record<PrintLayout, PrintSettings>> {
  const rows = await prisma.printLayoutSettings.findMany();
  const byLayout = new Map(rows.map((r) => [kindToLayout(r.layout), pick(r)]));
  return {
    wide: clampSettings("wide", byLayout.get("wide") ?? PRINT_DEFAULTS.wide),
    tall: clampSettings("tall", byLayout.get("tall") ?? PRINT_DEFAULTS.tall),
  };
}

/**
 * Сохранение. Значения приводятся к допустимым ЗДЕСЬ, а не только в форме: форму можно
 * обойти, а сломанная геометрия печатается молча — заметят её на бумаге и не сразу.
 */
export async function savePrintSettings(
  layout: PrintLayout,
  raw: PrintSettings,
  updatedBy: string
): Promise<PrintSettings> {
  const s = clampSettings(layout, raw);
  await prisma.printLayoutSettings.upsert({
    where: { layout: layoutToKind(layout) },
    create: { layout: layoutToKind(layout), ...s, updatedBy },
    update: { ...s, updatedBy },
  });
  return s;
}

/** Сброс к значениям по умолчанию — просто удаление строки. */
export async function resetPrintSettings(layout: PrintLayout): Promise<void> {
  await prisma.printLayoutSettings.deleteMany({ where: { layout: layoutToKind(layout) } });
}
