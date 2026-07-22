import "server-only";
/**
 * READ-ONLY автоподсказка meta-ключей заказов для UI «Сопоставление полей заказа».
 * Только чтение: resolveWooCredentials (findUnique) + GET /orders + collectMetaKeys (pure).
 * Значения meta НЕ возвращаются — только имена ключей и частота. Ничего не пишет в БД.
 */
import { resolveWooCredentials } from "./credentials";
import { wooGet } from "./client";
import { collectMetaKeys, type WooMeta } from "./orderMeta";

export async function suggestWooMetaKeys(
  siteId: string,
  opts: { limit?: number; client?: Parameters<typeof wooGet>[3] } = {}
): Promise<{ key: string; count: number }[]> {
  const limit = Math.min(Math.max(1, opts.limit ?? 20), 50);
  const creds = await resolveWooCredentials(siteId); // READ
  const { data } = await wooGet<{ meta_data?: WooMeta[] }[]>(creds, "/orders", { per_page: limit, orderby: "date", order: "desc" }, opts.client); // GET
  return collectMetaKeys(data ?? []); // pure — только ключи+счётчики, без значений
}
