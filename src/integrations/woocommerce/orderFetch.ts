import "server-only";
/**
 * Постраничная выборка заказов WooCommerce (`GET /orders`). Отдаёт сырые заказы; нормализация/
 * запись — в ingestWooOrder. Инъекция клиента (opts) для тестов.
 *
 * Граница выборки (`WooOrderBound`):
 *  - `modifiedAfter` → `modified_after=<ISO>`: только изменённые после watermark (инкрементально —
 *    ловит и новые заказы, и обновления статусов существующих);
 *  - `after` → `after=<ISO>`: по дате создания (начальное окно при пустом watermark);
 *  - пустая граница → без фильтра (вся история — только по явному подтверждению Полной синхронизации).
 */
import type { WooCredentials } from "./credentials";
import { wooGet, type WooClientOptions } from "./client";
import type { WooOrder } from "./orderAdapter";

const PAGE_SIZE = 100;

/** Полная сырая форма заказа, достаточная для ingestWooOrder. */
export type WooRawOrder = WooOrder & {
  payment_method?: string;
  payment_method_title?: string;
  transaction_id?: string;
  date_modified_gmt?: string;
  date_paid_gmt?: string | null;
  line_items?: unknown[];
  total?: string | number;
  total_tax?: string | number;
  shipping_total?: string | number;
  discount_total?: string | number;
};

/** Граница выборки заказов. Пустой объект = вся история (без фильтра по дате). */
export type WooOrderBound = { after?: string; modifiedAfter?: string };

/** Query-параметры фильтра из границы (WooCommerce: `after` / `modified_after`). */
function boundParams(bound: WooOrderBound): Record<string, string | undefined> {
  return {
    ...(bound.after ? { after: bound.after } : {}),
    ...(bound.modifiedAfter ? { modified_after: bound.modifiedAfter } : {}),
  };
}

/** Всего заказов в границе (для прогресса). null — если заголовок не отдан. */
export async function countWooOrders(creds: WooCredentials, bound: WooOrderBound, opts: WooClientOptions = {}): Promise<number | null> {
  const { total } = await wooGet<WooRawOrder[]>(creds, "/orders", { per_page: 1, ...boundParams(bound) }, opts);
  return total;
}

/** Постранично отдаёт заказы в границе (по возрастанию даты). */
export async function* fetchWooOrders(creds: WooCredentials, bound: WooOrderBound, opts: WooClientOptions = {}): AsyncGenerator<WooRawOrder> {
  let page = 1;
  for (;;) {
    const { data, totalPages } = await wooGet<WooRawOrder[]>(
      creds,
      "/orders",
      { per_page: PAGE_SIZE, page, orderby: "date", order: "asc", ...boundParams(bound) },
      opts
    );
    for (const o of data ?? []) yield o;
    if (!data || data.length < PAGE_SIZE || (totalPages != null && page >= totalPages)) break;
    page++;
  }
}
