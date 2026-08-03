/**
 * Тексты результата смены основной точки. Отдельно от server actions: в "use server"-модуле
 * можно экспортировать только async-функции, а один и тот же текст нужен двум действиям
 * (владелец в карточке флориста и флорист в своём кабинете).
 */
import type { SetPrimaryResult } from "./service";

export type PickupFormState = { error?: string; ok?: boolean; message?: string } | null;

export function setPrimaryFormState(res: SetPrimaryResult): PickupFormState {
  switch (res.outcome) {
    case "changed":
      return {
        ok: true,
        message: res.rescheduled
          ? `Основная точка изменена. Перепланировано будущих заказов: ${res.rescheduled}. Уже созданные доставки не затронуты.`
          : "Основная точка изменена. Уже созданные доставки не затронуты.",
      };
    case "unchanged":
      return { ok: true, message: "Эта точка уже основная." };
    case "inactive":
      return { error: "Точка отключена — сначала включите её." };
    case "not_found":
    default:
      return { error: "Точка не найдена." };
  }
}
