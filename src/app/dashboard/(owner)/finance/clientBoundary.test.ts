/**
 * Граница server/client в разделе «Финансы».
 *
 * Серверный компонент, импортирующий ЗНАЧЕНИЕ (массив, объект, функцию) из `"use client"`
 * модуля, получает не его, а client-reference прокси. Типы этого не видят, сборка проходит,
 * а страница падает в рантайме на первом же вызове метода — ровно так на проде развалилась
 * карточка флориста: `REVERSIBLE_TYPES.includes is not a function`.
 *
 * Правило: из клиентского модуля серверная страница импортирует ТОЛЬКО компоненты.
 * Всё остальное живёт в обычном модуле (см. modules/finance/ledgerRules.ts).
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

const FINANCE_DIR = path.join(process.cwd(), "src/app/dashboard/(owner)/finance");

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? walk(full) : [full];
  });
}

const isClientModule = (file: string) => /^\s*["']use client["']/.test(fs.readFileSync(file, "utf8"));

/** Компонент — PascalCase. Константы и функции таковыми не выглядят. */
const looksLikeComponent = (name: string) => /^[A-Z][A-Za-z0-9]*$/.test(name) && name !== name.toUpperCase();

describe("граница server/client в разделе «Финансы»", () => {
  const pages = walk(FINANCE_DIR).filter((f) => f.endsWith("page.tsx") && !isClientModule(f));

  it("серверных страниц раздела найдено больше нуля", () => {
    expect(pages.length).toBeGreaterThan(0);
  });

  it.each(pages)("%s импортирует из клиентских модулей только компоненты", (page) => {
    const source = fs.readFileSync(page, "utf8");
    const importRe = /import\s+\{([^}]+)\}\s+from\s+["'](\.[^"']+)["']/g;

    for (const m of source.matchAll(importRe)) {
      const names = m[1].split(",").map((s) => s.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);
      const resolved = ["tsx", "ts"]
        .map((ext) => path.join(path.dirname(page), `${m[2]}.${ext}`))
        .find((p) => fs.existsSync(p));
      if (!resolved || !isClientModule(resolved)) continue;

      for (const name of names) {
        expect(
          looksLikeComponent(name),
          `${path.basename(page)} импортирует «${name}» из клиентского модуля ${path.basename(resolved)}. ` +
            `Значения через границу RSC приходят прокси-объектом — вынесите его в обычный модуль.`
        ).toBe(true);
      }
    }
  });
});
