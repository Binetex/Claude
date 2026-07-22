/**
 * Разбивка ТЕКСТА ОТКРЫТКИ на части так, чтобы каждая помещалась в свою половину Letter.
 * Чистая функция: измерение высоты (`measure`) инъектируется — в браузере это реальный замер DOM
 * (учитывает шрифт/переносы/абзацы), в тестах — детерминированный мок.
 *
 * Гарантии: слова НЕ разрываются; порядок сохраняется; переносы строк сохраняются; текст не
 * обрезается (что не влезло — уходит на следующую часть). Границы разбиения — по словам.
 */

export type Measure = (partText: string) => number; // высота отрендеренного текста, px

export type SplitOptions = {
  firstHeightPx: number; // доступная высота текста на ПЕРВОЙ половине (после служебного блока)
  contHeightPx: number; // доступная высота на ПРОДОЛЖЕНИЯХ (после компактного заголовка)
};

/** Токены: пара (разделитель, слово). Разделитель хранит пробелы/переносы перед словом. */
function tokenize(text: string): { sep: string; word: string }[] {
  const out: { sep: string; word: string }[] = [];
  const re = /(\s*)(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.push({ sep: m[1], word: m[2] });
  return out;
}

/**
 * Возвращает массив частей (строк) в исходном порядке. Каждая часть помещается в свою половину
 * по инъектированному `measure`. Первая часть меряется по firstHeightPx, остальные — по contHeightPx.
 */
export function splitCardIntoParts(text: string, opts: SplitOptions, measure: Measure): string[] {
  const tokens = tokenize(text);
  if (tokens.length === 0) return [];

  const parts: string[] = [];
  let current = "";
  const budget = () => (parts.length === 0 ? opts.firstHeightPx : opts.contHeightPx);

  for (const { sep, word } of tokens) {
    // Кандидат: к текущей части добавляем разделитель (переносы сохраняем) + слово.
    const candidate = current === "" ? word : current + sep + word;
    if (measure(candidate) <= budget()) {
      current = candidate;
      continue;
    }
    // Не помещается.
    if (current === "") {
      // Одно слово выше бюджета половины — разрывать слово нельзя, кладём как есть (переполнит,
      // но это крайний случай очень длинного «слова»; текст не теряем и не режем).
      parts.push(word);
      continue;
    }
    // Закрываем текущую часть, слово начинает новую (ведущий разделитель отбрасываем).
    parts.push(current);
    current = word;
    // Если одно слово не влезает и в новую (cont) часть — оно всё равно остаётся началом части.
  }
  if (current !== "") parts.push(current);
  return parts;
}
