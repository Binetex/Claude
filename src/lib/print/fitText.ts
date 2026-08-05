/**
 * Подбор размера шрифта для текста открытки под ОДНУ половину листа.
 *
 * Порядок приоритетов (см. требования владельца):
 *   1) оставить базовый размер, если текст и так помещается;
 *   2) иначе уменьшать по одному пункту, пока не поместится;
 *   3) переносить на следующую половину — только если не помещается даже на минимуме.
 *
 * Решение принимается по РЕАЛЬНОЙ высоте отрендеренного текста (measure инъектируется: в
 * браузере это замер DOM с тем же шрифтом и шириной, что при печати), а не по числу символов —
 * иначе перенос строк, абзацы и длинные слова считаются неверно.
 *
 * Цикл конечен по построению: шагов не больше (base − min), дробных размеров нет.
 */
export type MeasureAt = (text: string, fontPt: number) => number;

export type FitOptions = {
  /** Базовый (и максимальный) размер, pt. */
  basePt: number;
  /** Ниже этого не опускаемся, pt. */
  minPt: number;
  /** Доступная высота текста в половине листа, px. */
  areaHeightPx: number;
  /** Шаг уменьшения, pt. */
  stepPt?: number;
};

export type FitResult = {
  /** Подобранный размер шрифта, pt. */
  fontPt: number;
  /** Помещается ли текст целиком на этом размере (иначе нужен перенос). */
  fits: boolean;
};

/**
 * Наибольший размер из диапазона, при котором текст помещается целиком.
 * Если не помещается даже на минимуме — возвращает минимум и fits: false.
 */
/** Высота одной строки, px: pt → px (96/72) с учётом line-height. */
export function lineHeightPx(fontPt: number, ratio: number): number {
  return ((fontPt * 96) / 72) * ratio;
}

/**
 * С какого кегля НАЧИНАТЬ подбор.
 *
 * Базовый оставляем только коротким запискам: «влезает» и «выглядит хорошо» — не одно и то
 * же. На пять строк 16pt смотрится крупно и по-плакатному, хотя место на карточке ещё есть,
 * поэтому с этого объёма текст сразу печатается ступенью мельче. Дальше работает обычный
 * подбор: если и на этой ступени не помещается, он опускает кегль ещё.
 */
export function startingFontPt(
  text: string,
  opts: { basePt: number; crowdedPt: number; maxLinesAtBase: number; lineHeightRatio: number },
  measure: MeasureAt
): number {
  const limit = opts.maxLinesAtBase * lineHeightPx(opts.basePt, opts.lineHeightRatio);
  // Половина строки допуска: браузер округляет высоту, и ровно maxLines строк не должны
  // случайно перевесить порог.
  const slack = lineHeightPx(opts.basePt, opts.lineHeightRatio) / 2;
  return measure(text, opts.basePt) > limit + slack ? opts.crowdedPt : opts.basePt;
}

export function fitFontPt(text: string, opts: FitOptions, measure: MeasureAt): FitResult {
  const step = opts.stepPt ?? 1;
  const min = Math.min(opts.minPt, opts.basePt);

  for (let pt = opts.basePt; pt >= min; pt -= step) {
    if (measure(text, pt) <= opts.areaHeightPx) return { fontPt: pt, fits: true };
  }
  // Даже на минимуме не помещается: печатаем минимальным и разбиваем на части — текст
  // не обрезаем и не прячем.
  return { fontPt: min, fits: false };
}
