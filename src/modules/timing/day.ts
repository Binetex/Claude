/**
 * Время доставки: чистые помощники, общие для расписания, графика и ассистента.
 *
 * Размер букета (большой — дольше собирать), граница утра, допуск опоздания, пожелания клиента из
 * заметки («готов принять …»), подписи времени. Всё, что считает «когда» и «успеем ли», — в
 * planner.ts по цифрам из model.ts.
 *
 * Чистый модуль: ни БД, ни «сейчас».
 */
/** Дешевле этого — не букет, а добавка (ваза, шарик, шоколад, открытка). */
export const BOUQUET_MIN_PRICE = 100;
/** От этой цены букет «большой»: делать его дольше. */
export const BIG_BOUQUET_PRICE = 250;
/** Утро — всё, что должно приехать до этого часа. */
export const MORNING_END_HOUR = 15;
/** Опоздание в пределах этого — не опоздание (решение владельца: «20 минут — ничего страшного»). */
export const LATE_TOLERANCE_MIN = 20;

export type OrderItemLike = { price: number; quantity?: number };

export function isBigOrder(items: OrderItemLike[]): boolean {
  return items.some((it) => it.price >= BIG_BOUQUET_PRICE);
}

/**
 * Пожелания времени из заметки заказа: ассистент пишет их строкой «… готов принять <время>»
 * (assistant/note.ts). Свежие сверху. Окно заказа они не меняют — окно ставит тот, кто обещал
 * время (карточка заказа или ассистент), — а на графике показываются как есть.
 */
export function readyTimeWishes(customerNote: string | null | undefined): string[] {
  return (customerNote ?? "")
    .split("\n")
    .map((l) => l.match(/готов принять\s+(.+)$/)?.[1]?.trim() ?? "")
    .filter(Boolean);
}

/** «2:30 PM», «1 PM» — время для текста клиенту. */
export function clockLabelEn(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${h % 12 === 0 ? 12 : h % 12}${m ? `:${String(m).padStart(2, "0")}` : ""} ${h < 12 ? "AM" : "PM"}`;
}

/** «42 мин», «3 ч 12 мин», «2 ч». */
export function fmtDuration(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (!h) return `${m} мин`;
  return m ? `${h} ч ${m} мин` : `${h} ч`;
}
