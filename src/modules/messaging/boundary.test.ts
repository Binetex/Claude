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
 * поэтому orderSource зовёт чистую locationPick. Второго импорта из reviews в messaging
 * быть не должно — появился новый, значит граница поплыла.
 *
 * Тесты (*.test.ts) из проверки исключены: интеграционный тест законно собирает обе
 * стороны вместе.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? walk(full) : [full];
  });
}

const sources = (dir: string) =>
  walk(path.join(process.cwd(), `src/modules/${dir}`)).filter(
    (f) => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f)
  );

const importsOf = (file: string) =>
  [...fs.readFileSync(file, "utf8").matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);

describe("граница messaging / automations / reviews", () => {
  it("модуль messaging на месте и не пуст", () => {
    expect(sources("messaging").length).toBeGreaterThanOrEqual(7);
  });

  it("reviews не импортирует automations — общий слой берётся из messaging", () => {
    for (const file of sources("reviews")) {
      for (const imp of importsOf(file)) {
        expect(
          /modules\/automations|\.\.\/automations/.test(imp),
          `${path.relative(process.cwd(), file)} импортирует «${imp}» — reviews не должен знать про automations`
        ).toBe(false);
      }
    }
  });

  it("messaging не импортирует automations — слой ниже, а не сбоку", () => {
    for (const file of sources("messaging")) {
      for (const imp of importsOf(file)) {
        expect(
          /modules\/automations|\.\.\/automations/.test(imp),
          `${path.relative(process.cwd(), file)} импортирует «${imp}» — messaging не должен знать про automations`
        ).toBe(false);
      }
    }
  });

  it("из reviews в messaging входит только locationPick", () => {
    for (const file of sources("messaging")) {
      for (const imp of importsOf(file)) {
        if (!/modules\/reviews|\.\.\/reviews/.test(imp)) continue;
        expect(
          imp,
          `${path.relative(process.cwd(), file)} импортирует «${imp}» — из reviews разрешена только чистая locationPick (ради {{review_url}})`
        ).toBe("@/modules/reviews/locationPick");
      }
    }
  });
});
