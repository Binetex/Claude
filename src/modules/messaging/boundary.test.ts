/**
 * Граница слоёв отправки сообщений.
 *
 * История: общий слой (каналы, шаблоны, переменные) жил внутри automations, и reviews
 * импортировал его оттуда напрямую. Любая правка внутренностей automations молча ломала
 * отзывы — тесты соседнего модуля этого не видели. Теперь слой живёт в modules/messaging,
 * и направления закреплены здесь:
 *
 *   automations ──▶ messaging ◀── reviews        (оба знают только общий слой)
 *   messaging ──▶ reviews/locationPick            (единственное исключение, см. ниже)
 *
 * Исключение одно и намеренное: {{review_url}} обязан совпадать с разделом «Отзывы»,
 * поэтому orderSource зовёт чистую locationPick. Второй импорт из reviews в messaging —
 * граница поплыла.
 *
 * Импорты достаёт ts.preProcessFile: он видит static, side-effect `import "..."`,
 * динамический `import()` и `require()`, а комментарии не считает — самописный регекс
 * прокалывался на всех этих формах разом. Принадлежность модулю решается резолвом пути,
 * а не подстрокой: modules/automations-ui не считается automations. Тесты (*.test.ts)
 * из проверки исключены: интеграционный тест законно собирает обе стороны вместе.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// Якорь от самого файла, не от process.cwd(): vitest не делает chdir воркера,
// и запуск не из корня репо ронял бы тест посторонним ENOENT.
const MODULES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC_DIR = path.resolve(MODULES_DIR, "..");

function sources(mod: string): string[] {
  return fs
    .readdirSync(path.join(MODULES_DIR, mod), { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name))
    .map((e) => path.join(e.parentPath, e.name));
}

/** Все импортируемые файлом пути: static, side-effect, dynamic import(), require(). */
const importsOf = (file: string) =>
  ts.preProcessFile(fs.readFileSync(file, "utf8"), true, true).importedFiles.map((f) => f.fileName);

/** Абсолютный путь цели импорта; null для пакетов из node_modules. */
function resolveImport(file: string, imp: string): string | null {
  if (imp.startsWith("@/")) return path.join(SRC_DIR, imp.slice(2));
  if (imp.startsWith(".")) return path.resolve(path.dirname(file), imp);
  return null;
}

/** Импорт ведёт внутрь src/modules/<mod>? Сравнение по границе каталога, не по подстроке. */
function pointsInto(file: string, imp: string, mod: string): boolean {
  const target = resolveImport(file, imp);
  if (!target) return false;
  const root = path.join(MODULES_DIR, mod);
  return target === root || target.startsWith(root + path.sep);
}

const rel = (file: string) => path.relative(SRC_DIR, file);

describe("граница messaging / automations / reviews", () => {
  const FORBIDDEN: ReadonlyArray<readonly [string, string]> = [
    ["reviews", "automations"],
    ["messaging", "automations"],
    ["automations", "reviews"],
  ];

  it.each(FORBIDDEN)("%s не импортирует %s", (from, into) => {
    const files = sources(from);
    // Пустой скан означал бы вакуумный «зелёный» проход при переименованном каталоге.
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      for (const imp of importsOf(file)) {
        expect(
          pointsInto(file, imp, into),
          `${rel(file)} импортирует «${imp}» — ${from} не должен знать про ${into}`
        ).toBe(false);
      }
    }
  });

  it("из reviews в messaging входит только locationPick", () => {
    const allowed = path.join(MODULES_DIR, "reviews", "locationPick");
    for (const file of sources("messaging")) {
      for (const imp of importsOf(file)) {
        if (!pointsInto(file, imp, "reviews")) continue;
        expect(
          resolveImport(file, imp),
          `${rel(file)} импортирует «${imp}» — из reviews разрешена только чистая locationPick (ради {{review_url}})`
        ).toBe(allowed);
      }
    }
  });
});
