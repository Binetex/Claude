/**
 * Выбор точки забора для заказа. Чистая функция — ЕДИНСТВЕННЫЙ способ ответить на вопрос
 * «откуда курьер забирает этот заказ». Второй способ уже существовал (persistDraft и
 * linkService отдельно доставали точку по floristId) и при одной точке на флориста давал тот
 * же ответ; при нескольких точках он начал бы врать, поэтому сведён сюда.
 *
 * Правила:
 *  - ручной выбор оператора (Order.pickupLocationOverrideId) — если точка принадлежит
 *    назначенному флористу и активна. Чужая или отключённая точка молча игнорируется:
 *    после переназначения флориста заказ обязан вернуться к точке НОВОГО флориста;
 *  - иначе — основная (isPrimary) активная точка флориста;
 *  - иначе null → вызывающий уходит в существующий pickup_invalid → WAITING_FOR_FLORIST.
 *    Новых состояний и skip-кодов не заводим.
 */

/** Минимум полей точки, нужный для выбора. Совместим со строкой FloristPickupLocation. */
export type PickupCandidate = {
  id: string;
  floristId: string;
  isPrimary: boolean;
  isActive: boolean;
};

export type PickupSource = "ORDER_OVERRIDE" | "FLORIST_PRIMARY";

export type ResolvePickupInput<T extends PickupCandidate> = {
  /** Ручной выбор в заказе (Order.pickupLocationOverrideId). */
  overrideId: string | null | undefined;
  /** Точки НАЗНАЧЕННОГО флориста (все, включая отключённые). */
  floristPickups: T[];
};

export type ResolvedPickup<T extends PickupCandidate> = { location: T; source: PickupSource };

export function resolvePickupForOrder<T extends PickupCandidate>(input: ResolvePickupInput<T>): ResolvedPickup<T> | null {
  const { overrideId, floristPickups } = input;

  if (overrideId) {
    const chosen = floristPickups.find((p) => p.id === overrideId && p.isActive);
    if (chosen) return { location: chosen, source: "ORDER_OVERRIDE" };
  }

  const primary = floristPickups.find((p) => p.isPrimary && p.isActive);
  if (primary) return { location: primary, source: "FLORIST_PRIMARY" };

  return null;
}

/**
 * Действует ли сейчас ручной выбор точки. Нужно интерфейсу, чтобы честно писать «выбрана
 * вручную» / «основная точка флориста», а не показывать сохранённый, но не применяемый выбор.
 */
export function isOverrideEffective<T extends PickupCandidate>(input: ResolvePickupInput<T>): boolean {
  return resolvePickupForOrder(input)?.source === "ORDER_OVERRIDE";
}
