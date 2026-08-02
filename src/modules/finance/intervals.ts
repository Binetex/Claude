/**
 * Арифметика цепочки эффективно-датированных периодов.
 *
 * Чистые функции без БД. Вынесены отдельно намеренно: это самая опасная часть правки
 * настроек — здесь легко оставить дыру в покрытии или наложение, а в БД наложение ловит
 * GiST-ограничение (и падает уже после того, как половина изменений применена).
 * Проверять такое надо тестами, а не на боевых данных.
 *
 * Соглашение о периодах: `[effectiveFrom, effectiveTo)`, `effectiveTo = null` — открыт
 * вправо. Соседние периоды в цепочке СМЫКАЮТСЯ: конец предыдущего равен началу
 * следующего. Это инвариант, который поддерживают и создание новой ставки, и правки
 * здесь: между двумя записями не должно появляться дня без настройки.
 */

export type IntervalRow = { id: string; effectiveFrom: Date; effectiveTo: Date | null };

/**
 * Шаг применения. Порядок в массиве значим: сжатие идёт раньше расширения, иначе
 * промежуточное состояние нарушит ограничение непересечения и транзакция упадёт.
 */
export type IntervalStep =
  | { kind: "SET_TO"; id: string; effectiveTo: Date | null }
  | { kind: "SET_FROM"; id: string; effectiveFrom: Date }
  | { kind: "DELETE"; id: string };

export class IntervalError extends Error {
  constructor(
    public readonly reason: string,
    message: string
  ) {
    super(message);
    this.name = "IntervalError";
  }
}

const byFrom = (a: IntervalRow, b: IntervalRow) => a.effectiveFrom.getTime() - b.effectiveFrom.getTime();

function locate(rows: IntervalRow[], targetId: string) {
  const sorted = [...rows].sort(byFrom);
  const index = sorted.findIndex((r) => r.id === targetId);
  if (index === -1) throw new IntervalError("not_found", "Запись не найдена.");
  return {
    sorted,
    index,
    target: sorted[index],
    prev: index > 0 ? sorted[index - 1] : null,
    next: index < sorted.length - 1 ? sorted[index + 1] : null,
  };
}

/**
 * Исправление даты начала записи.
 *
 * Это именно ИСПРАВЛЕНИЕ ошибки ввода, а не смена ставки: правится существующий период,
 * новый не создаётся. Граница двигается вместе с концом предыдущего периода — они
 * смыкаются, поэтому подвинуть одну сторону и не подвинуть другую значит либо создать
 * дыру, либо наложение.
 */
export function planIntervalCorrection(rows: IntervalRow[], targetId: string, nextFrom: Date): IntervalStep[] {
  const { target, prev, next } = locate(rows, targetId);

  if (prev && nextFrom.getTime() <= prev.effectiveFrom.getTime()) {
    throw new IntervalError(
      "before_previous",
      `Дата должна быть позже начала предыдущего периода (${prev.effectiveFrom.toISOString().slice(0, 10)}).`
    );
  }
  if (next && nextFrom.getTime() >= next.effectiveFrom.getTime()) {
    throw new IntervalError(
      "after_next",
      `Дата должна быть раньше начала следующего периода (${next.effectiveFrom.toISOString().slice(0, 10)}).`
    );
  }
  if (target.effectiveTo && nextFrom.getTime() >= target.effectiveTo.getTime()) {
    throw new IntervalError("empty_period", "Период получился бы пустым: начало не раньше конца.");
  }

  if (nextFrom.getTime() === target.effectiveFrom.getTime()) return [];
  if (!prev) return [{ kind: "SET_FROM", id: target.id, effectiveFrom: nextFrom }];

  // Сначала тот период, который сжимается, — иначе в промежуточном состоянии они
  // наложатся друг на друга и сработает ограничение непересечения.
  return nextFrom.getTime() > target.effectiveFrom.getTime()
    ? [
        { kind: "SET_FROM", id: target.id, effectiveFrom: nextFrom },
        { kind: "SET_TO", id: prev.id, effectiveTo: nextFrom },
      ]
    : [
        { kind: "SET_TO", id: prev.id, effectiveTo: nextFrom },
        { kind: "SET_FROM", id: target.id, effectiveFrom: nextFrom },
      ];
}

/**
 * Удаление записи.
 *
 * Предыдущий период забирает себе освободившийся отрезок — включая открытый конец, если
 * удаляемая запись была последней. Дыры не остаётся никогда; исключение одно и оно
 * честное: если удалить САМУЮ РАННЮЮ запись, её отрезок остаётся непокрытым, потому что
 * покрыть его нечем. Настройка там просто перестаёт существовать, и это должен увидеть
 * детектор, а не спрятать эта функция.
 */
export function planIntervalDeletion(rows: IntervalRow[], targetId: string): IntervalStep[] {
  const { target, prev } = locate(rows, targetId);
  const steps: IntervalStep[] = [{ kind: "DELETE", id: target.id }];
  if (prev) steps.push({ kind: "SET_TO", id: prev.id, effectiveTo: target.effectiveTo });
  return steps;
}

/** Останется ли после удаления хоть одна запись — иначе настройки не будет вовсе. */
export function leavesNoCoverage(rows: IntervalRow[], targetId: string): boolean {
  return rows.filter((r) => r.id !== targetId).length === 0;
}

/**
 * Отрезок дат, расчёт которых может измениться.
 *
 * Берётся объединение того, что запись покрывала ДО правки, и того, что покроет ПОСЛЕ:
 * при сдвиге границы меняются дни по обе стороны от неё. Правый край открытого периода —
 * `null`, вызывающий подставляет вместо него «сегодня».
 */
export function affectedRange(
  rows: IntervalRow[],
  targetId: string,
  change: { nextFrom?: Date }
): { from: Date; to: Date | null } {
  const { target } = locate(rows, targetId);

  // При удалении отрезок записи достаётся предыдущему периоду — меняется расчёт ровно
  // этих дней. Собственное покрытие предыдущего периода не трогается, и включать его в
  // диапазон незачем: пересчёт там всё равно дал бы то же самое.
  const froms = [target.effectiveFrom, ...(change.nextFrom ? [change.nextFrom] : [])];
  const from = new Date(Math.min(...froms.map((d) => d.getTime())));
  return { from, to: target.effectiveTo };
}
