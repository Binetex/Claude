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
/** Вечер: с этого часа открыт день под замком «только вечер» и привозим сегодняшний заказ без места. */
export const EVENING_START_MIN = 18 * 60;
/**
 * Вечерний заказ для очереди флориста — окно начинается с этого часа. Такой заказ TheFlow не
 * лезет в начало очереди: он после дневных заказов всех магазинов (владелец 30.09.2026: «вечерние
 * заказы TheFlow не надо пихать в начало очереди, их можно после утренних с других сайтов»).
 */
export const EVENING_ORDER_MIN = 17 * 60;
/**
 * Сегодня раньше этого доставку не обещаем (владелец 30.09.2026: «обычно у нас в 11 утра доставляют
 * самое раннее»), и заранее сами тоже называем его. Без порога «Новый заказ» на завтра показывал
 * 8:30 (ранний старт флориста с 6:00), и ассистент назвал бы это клиенту.
 */
export const EARLIEST_DELIVERY_MIN = 11 * 60;
/**
 * Заказ заранее (доставка завтра и дальше): раньше 11 — с 8 утра, но ТОЛЬКО если клиент сам просит
 * раньше (владелец 30.09.2026: «на завтра можно согласовывать 8–9 утра, если клиент просит; это
 * только если доставка как минимум на день вперёд»).
 */
export const EARLIEST_DELIVERY_AHEAD_MIN = 8 * 60;
/**
 * После этого часа цветы на сегодня уже не закупить (владелец 29.09.2026): новый заказ на сегодня
 * не обещаем и не отклоняем сами — решает человек. До него сегодня берём всегда.
 */
export const SAME_DAY_CUTOFF_MIN = 13 * 60;

/**
 * Главный магазин (владелец 29.09.2026): «первостепенно доставить заказы TheFlow, остальные сайты —
 * второстепенно, опоздаем там — ничего страшного». Его заказы в очереди обязаны успеть.
 */
const PRIORITY_SHOPS = new Set(["THEFLOW"]);

export function isPriorityShop(shortName: string | null | undefined): boolean {
  return !!shortName && PRIORITY_SHOPS.has(shortName.toUpperCase());
}

/**
 * Замок дня в «Графике доставки»: утро закрыто (с 15:00), только вечер (с 18:00), весь день.
 * Его видят ИИ и сайты с плагином доставки (`/api/public/morning-closures`).
 */
export type ClosureLevel = "MORNING" | "DAY" | "FULL";
export const CLOSURE_LEVELS: ClosureLevel[] = ["MORNING", "DAY", "FULL"];

/** С какой минуты день открыт под замком; null — закрыт целиком. */
export const CLOSURE_OPEN_FROM: Record<ClosureLevel, number | null> = {
  MORNING: MORNING_END_HOUR * 60,
  DAY: EVENING_START_MIN,
  FULL: null,
};

export function asClosureLevel(v: string | null | undefined): ClosureLevel | null {
  return CLOSURE_LEVELS.includes(v as ClosureLevel) ? (v as ClosureLevel) : null;
}

/**
 * Утро закрывается само, когда по графику утренний заказ TheFlow опаздывает хотя бы на столько
 * (владелец 01.10.2026: «чтобы бот сам закрывал утренний слот — когда уже прям точно не успеваем
 * на 1–2 часа»; повод — пять заказов на слот 11–15 при лимите плагина в четыре).
 */
export const AUTO_CLOSE_LATE_MIN = 60;

export type PlannedOrderLike = {
  id: string;
  orderNumber: string;
  site: string;
  plannedAt: number | null;
  promised: { from: number; to: number } | null;
};

/**
 * Самый опаздывающий утренний заказ главного магазина, если опоздание дошло до порога автозамка;
 * иначе null. Утренний — окно начинается до 15:00 (утренний слот сайта 11–15). Чужие магазины не
 * считаются: их опоздание новый заказ TheFlow не останавливает (`planner.ts::canFit`).
 */
export function morningOverload(orders: PlannedOrderLike[]): { id: string; orderNumber: string; lateMin: number } | null {
  let worst: { id: string; orderNumber: string; lateMin: number } | null = null;
  for (const o of orders) {
    if (!isPriorityShop(o.site) || o.plannedAt == null || !o.promised) continue;
    if (o.promised.from >= MORNING_END_HOUR * 60) continue;
    const lateMin = o.plannedAt - o.promised.to;
    if (lateMin >= AUTO_CLOSE_LATE_MIN && (!worst || lateMin > worst.lateMin)) worst = { id: o.id, orderNumber: o.orderNumber, lateMin };
  }
  return worst;
}

/**
 * Самое раннее время с учётом замка дня. Весь день закрыт — новых заказов нет, а уже принятые
 * возим как обычно: отказывать им из-за замка значило бы перенести чужую оплаченную доставку.
 */
export function withClosure(earliest: number | null, level: ClosureLevel | null, forNewOrder: boolean): number | null {
  // Замок — для НОВЫХ заказов. Принятый заказ возим как обычно на любом замке: «Утро закрыто» не
  // двигает его утреннее окно (раньше двигало, и ИИ писал клиенту «к часу не успеем»).
  if (earliest == null || !level || !forNewOrder) return earliest;
  const from = CLOSURE_OPEN_FROM[level];
  if (from == null) return null;
  return Math.max(earliest, from);
}

/** Новый заказ на сегодня до 13:00 берём всегда: места по графику нет — значит, вечером. */
export function sameDayFallback(planned: number | null, nowMin: number): number | null {
  return planned ?? (nowMin < SAME_DAY_CUTOFF_MIN ? EVENING_START_MIN : null);
}

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
