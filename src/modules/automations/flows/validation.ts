/**
 * Валидация цепочки. Чистый модуль: одни и те же правила проверяют server action при
 * сохранении и тесты — расхождению «в форме можно, в БД нельзя» взяться неоткуда.
 *
 * Сообщения возвращаются готовыми к показу владельцу (по-русски), первая ошибка — итог.
 */
import { isSupportedTrigger } from "../triggers";

/** Единицы ожидания, доступные в редакторе цепочек (минуты/часы/дни). */
export const FLOW_WAIT_UNITS = ["MINUTE", "HOUR", "DAY"] as const;
export type FlowWaitUnit = (typeof FLOW_WAIT_UNITS)[number];

export const FLOW_STEP_TYPES = ["WAIT", "EMAIL", "SMS"] as const;
export type FlowStepTypeInput = (typeof FLOW_STEP_TYPES)[number];

export type FlowStepInput = {
  position: number;
  type: FlowStepTypeInput;
  waitAmount: number | null;
  waitUnit: FlowWaitUnit | null;
  brevoTemplateId: number | null;
  template: string | null;
};

export type FlowInput = {
  name: string;
  siteIds: string[];
  triggerType: string;
  active: boolean;
  steps: FlowStepInput[];
};

const WAIT_UNITS = new Set<string>(FLOW_WAIT_UNITS);
const STEP_TYPES = new Set<string>(FLOW_STEP_TYPES);

/** Максимум для SMS — тот же, что у одиночных правил. */
const SMS_MAX_LENGTH = 1600;

/** Позиции обязаны быть ровно 1..N по порядку: цепочка линейна, «дыры» ломают продвижение. */
export function validateStepPositions(positions: number[]): string | null {
  const sorted = [...positions].sort((a, b) => a - b);
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i] !== i + 1) return "Позиции шагов должны идти подряд начиная с 1.";
  }
  return null;
}

export function validateFlowStep(step: FlowStepInput, index: number): string | null {
  const at = `Шаг ${index + 1}`;
  if (!STEP_TYPES.has(step.type)) return `${at}: неизвестный тип шага.`;

  if (step.type === "WAIT") {
    if (!Number.isInteger(step.waitAmount) || (step.waitAmount ?? 0) <= 0) {
      return `${at}: у ожидания должно быть положительное целое количество.`;
    }
    if (!step.waitUnit || !WAIT_UNITS.has(step.waitUnit)) {
      return `${at}: у ожидания должна быть выбрана единица (минуты, часы или дни).`;
    }
    return null;
  }

  if (step.type === "EMAIL") {
    if (!Number.isInteger(step.brevoTemplateId) || (step.brevoTemplateId ?? 0) <= 0) {
      return `${at}: у письма должен быть указан Brevo Template ID (целое положительное число).`;
    }
    return null;
  }

  // SMS
  if (!step.template?.trim()) return `${at}: введите текст SMS.`;
  if (step.template.length > SMS_MAX_LENGTH) return `${at}: слишком длинный текст (макс. ${SMS_MAX_LENGTH} символов).`;
  return null;
}

export function validateFlow(input: FlowInput): string | null {
  if (!input.name?.trim()) return "Укажите название цепочки.";
  if (!Array.isArray(input.siteIds) || input.siteIds.length === 0) return "Выберите хотя бы один магазин.";
  if (!isSupportedTrigger(input.triggerType)) return "Неизвестный триггер.";

  const steps = input.steps ?? [];
  if (steps.length === 0) return "Добавьте хотя бы один шаг.";

  const positionsError = validateStepPositions(steps.map((s) => s.position));
  if (positionsError) return positionsError;

  const ordered = [...steps].sort((a, b) => a.position - b.position);
  for (let i = 0; i < ordered.length; i++) {
    const err = validateFlowStep(ordered[i], i);
    if (err) return err;
  }

  // Ожидание в конце ничего не даёт: цепочка просто «повисит» и завершится без действия.
  if (ordered[ordered.length - 1].type === "WAIT") return "Последним шагом не может быть ожидание.";

  return null;
}
