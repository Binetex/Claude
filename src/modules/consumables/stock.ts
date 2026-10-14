/**
 * Остаток расходников по флористам — чистый расчёт, без БД.
 *
 * Владелец 14.10.2026: «500 коробок из Китая пришли Ольге — помечаю; потом Ольга передала 200
 * Насте». Остаток флориста = его приход ± передачи − расход его заказов (заказ делает назначенный
 * флорист). Хранимого остатка нет, как и раньше: он выводится из записей и не разъезжается с ними
 * при правке задним числом.
 *
 * Расход считается С ПЕРВОГО ПРИХОДА этого расходника у этого флориста (закупка или передача ему).
 * Приход начали записывать 14.10.2026, а заказы — с августа: вычитая всю историю, остаток у всех
 * уходил в сотни минусов, и запись «Ольге пришло 500» показывала бы 387 — прошлые коробки были из
 * старых, никогда не записанных запасов. Нет прихода вовсе — флорист этот расходник не ведёт: «—».
 *
 * Ключ флориста — его id; пустая строка — «без флориста»: приход, записанный до разделения, и
 * заказы без назначения.
 */

export const NO_FLORIST = "";

export type StockReceipt = {
  itemId: string;
  floristId: string | null;
  quantity: number;
  /** Строка передачи между флористами (минус у отдавшего, плюс у получившего). */
  transferId: string | null;
  /** День записи «YYYY-MM-DD». */
  day: string;
};

/** Сколько расходника ушло в заказ флориста в день доставки «YYYY-MM-DD». */
export type StockUsage = { itemId: string; floristId: string | null; day: string; quantity: number };

export type StockCell = {
  /** Пришло: закупки на этого флориста. */
  received: number;
  /** Передачи: плюс — получил от других, минус — отдал. */
  transferred: number;
  /** Ушло в его заказы — с первого прихода. */
  used: number;
  left: number;
  /** С какого дня ведётся учёт: первый приход или передача. */
  since: string;
};

/** itemId → флорист → ячейка. Флорист без прихода этого расходника в карте не появляется. */
export function stockByFlorist(receipts: StockReceipt[], usages: StockUsage[]): Map<string, Map<string, StockCell>> {
  const out = new Map<string, Map<string, StockCell>>();
  for (const r of receipts) {
    const key = r.floristId ?? NO_FLORIST;
    const byFlorist = out.get(r.itemId) ?? out.set(r.itemId, new Map()).get(r.itemId)!;
    const c = byFlorist.get(key) ?? byFlorist.set(key, { received: 0, transferred: 0, used: 0, left: 0, since: r.day }).get(key)!;
    if (r.transferId) c.transferred += r.quantity;
    else c.received += r.quantity;
    if (r.day < c.since) c.since = r.day;
  }
  for (const u of usages) {
    const c = out.get(u.itemId)?.get(u.floristId ?? NO_FLORIST);
    if (c && u.day >= c.since) c.used += u.quantity;
  }
  for (const byFlorist of out.values()) {
    for (const c of byFlorist.values()) c.left = c.received + c.transferred - c.used;
  }
  return out;
}

/** Сумма по всем флористам: передачи между ними взаимно гасятся. */
export function stockTotal(byFlorist: Map<string, StockCell> | undefined): Omit<StockCell, "since"> {
  const t = { received: 0, transferred: 0, used: 0, left: 0 };
  for (const c of byFlorist?.values() ?? []) {
    t.received += c.received;
    t.transferred += c.transferred;
    t.used += c.used;
    t.left += c.left;
  }
  return t;
}
