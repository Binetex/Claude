/**
 * Рендер SMS-шаблона. Подстановка `{{var}}` → значение из карты переменных.
 *  - отсутствующая/пустая переменная → "" (в текст НИКОГДА не попадает «undefined»);
 *  - строки, ставшие пустыми из-за подстановки (напр. «Track: {{tracking_url}}» без ссылки),
 *    схлопываются, чтобы не оставалось висячих меток и лишних пустых строк;
 *  - `missing` возвращает переменные, у которых не оказалось непустого значения — для
 *    предупреждения в UI и для гейтинга обязательных переменных на стороне отправителя.
 */

const VAR_RE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;
const HAS_VAR = /\{\{\s*[a-zA-Z_][a-zA-Z0-9_]*\s*\}\}/; // без флага /g — без состояния

/** Уникальные имена переменных, использованных в шаблоне (в порядке первого появления). */
export function extractVariables(template: string): string[] {
  const seen = new Set<string>();
  for (const m of template.matchAll(VAR_RE)) seen.add(m[1]);
  return [...seen];
}

export type RenderResult = {
  text: string;
  /** Переменные шаблона без непустого значения (undefined или ""). */
  missing: string[];
};

export function renderTemplate(template: string, vars: Record<string, string>): RenderResult {
  const missing = new Set<string>();
  const substitute = (line: string) =>
    line.replace(VAR_RE, (_full, key: string) => {
      const value = vars[key];
      if (value === undefined || value === null || value === "") {
        missing.add(key);
        return "";
      }
      return value;
    });

  // Построчно: строку, которая СОДЕРЖАЛА переменные и стала пустой из-за подстановки, убираем
  // целиком (иначе останется висячая метка/пустая строка). Пустые строки, ЗАДАННЫЕ автором
  // (без переменных), сохраняем как абзацные отступы.
  const out: string[] = [];
  for (const line of template.split("\n")) {
    const hadVar = HAS_VAR.test(line);
    const rendered = substitute(line).replace(/[ \t]+$/g, "");
    if (hadVar && rendered.trim() === "") continue;
    out.push(rendered);
  }

  const text = out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return { text, missing: [...missing] };
}
