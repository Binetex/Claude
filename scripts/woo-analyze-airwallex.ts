import "dotenv/config";
/**
 * READ-ONLY анализ реальных WooCommerce-заказов для определения признаков Airwallex/Klarna
 * pending. НИЧЕГО не пишет, не импортирует, не публикует события, не шлёт сообщения, не трогает
 * БД Floremart. Делает только `GET /orders` (максимум 50) и печатает ОБЕЗЛИЧЕННУЮ сводку.
 *
 * Запуск (credentials — через ENV, НЕ в коде и НЕ в чат):
 *   WOO_STORE_URL="https://example.com" \
 *   WOO_CONSUMER_KEY="ck_..." WOO_CONSUMER_SECRET="cs_..." \
 *   NODE_OPTIONS=--conditions=react-server \
 *   node_modules/.bin/tsx scripts/woo-analyze-airwallex.ts
 *
 * Защита PII: выводятся ТОЛЬКО безопасные поля (order id, дата, status, payment_method,
 * payment_method_title, наличие transaction_id, имена meta-ключей и безопасные значения
 * платёжных meta). Имена/email/телефоны/адрес/открытка/заметка/полный payload — не выводятся.
 */
import { normalizeStoreUrl } from "@/integrations/woocommerce/url";
import { wooGet } from "@/integrations/woocommerce/client";
import type { WooCredentials } from "@/integrations/woocommerce/credentials";
import { PAYMENT_KEY_RE, safePaymentMeta, type WooMeta } from "@/integrations/woocommerce/redact";

const MAX_ORDERS = 50;

type WooOrder = {
  id: number | string;
  status?: string;
  date_created_gmt?: string;
  payment_method?: string;
  payment_method_title?: string;
  transaction_id?: string;
  date_paid_gmt?: string | null;
  meta_data?: WooMeta[];
};

function credsFromEnv(): WooCredentials {
  const url = process.env.WOO_STORE_URL ?? "";
  const ck = process.env.WOO_CONSUMER_KEY ?? "";
  const cs = process.env.WOO_CONSUMER_SECRET ?? "";
  if (!url || !ck || !cs) {
    console.error("ОШИБКА: задайте WOO_STORE_URL, WOO_CONSUMER_KEY, WOO_CONSUMER_SECRET в ENV (не в чат).");
    process.exit(1);
  }
  const norm = normalizeStoreUrl(url);
  if (!norm.ok) {
    console.error(`ОШИБКА URL: ${norm.reason}`);
    process.exit(1);
  }
  return { siteId: "analysis", storeUrl: norm.storeUrl, apiBaseUrl: norm.apiBaseUrl, apiVersion: norm.apiVersion, consumerKey: ck, consumerSecret: cs };
}

/** Есть ли у заказа признаки Airwallex/Klarna. */
function airwallexSignals(o: WooOrder): { keys: string[]; isAirwallexMethod: boolean; isKlarnaTitle: boolean; statusHit: boolean } {
  const keys = (o.meta_data ?? []).map((m) => m.key ?? "").filter((k) => /airwallex|klarna|pay_?later|intent|bnpl/i.test(k));
  const isAirwallexMethod = /airwallex|klarna/i.test(o.payment_method ?? "");
  const isKlarnaTitle = /klarna|pay\s*later|airwallex/i.test(o.payment_method_title ?? "");
  const statusHit = /airwallex|pending/i.test(o.status ?? "");
  return { keys, isAirwallexMethod, isKlarnaTitle, statusHit };
}

function category(o: WooOrder, sig: ReturnType<typeof airwallexSignals>): string {
  const s = (o.status ?? "").toLowerCase();
  if (s === "refunded") return "REFUNDED";
  if (s === "failed" || s === "cancelled") return "FAILED/CANCELLED";
  if (s === "completed" || s === "processing") return sig.isAirwallexMethod || sig.isKlarnaTitle ? "AIRWALLEX_SUCCESS" : "NORMAL_PAID";
  // pending / on-hold / airwallex-* :
  if (sig.isAirwallexMethod || sig.isKlarnaTitle || sig.keys.length) return "AIRWALLEX_PENDING_CANDIDATE";
  return "NORMAL_PENDING";
}

async function main() {
  const creds = credsFromEnv();
  console.log(`# READ-ONLY анализ WooCommerce — ${creds.storeUrl} (endpoint ${creds.apiBaseUrl})`);
  console.log(`# Только GET /orders, максимум ${MAX_ORDERS}, обезличенный вывод. Ничего не изменяется.\n`);

  // Проверка доступа + выборка последних заказов (read-only).
  const { data: orders, total } = await wooGet<WooOrder[]>(creds, "/orders", { per_page: MAX_ORDERS, orderby: "date", order: "desc" });
  console.log(`Получено заказов: ${orders?.length ?? 0} (всего в магазине по заголовку: ${total ?? "?"})\n`);

  const buckets = new Map<string, WooOrder[]>();
  const methodCounts = new Map<string, number>();
  const titleCounts = new Map<string, number>();
  const statusCounts = new Map<string, number>();
  const metaKeyCounts = new Map<string, number>();

  for (const o of orders ?? []) {
    const sig = airwallexSignals(o);
    const cat = category(o, sig);
    if (!buckets.has(cat)) buckets.set(cat, []);
    buckets.get(cat)!.push(o);
    methodCounts.set(o.payment_method ?? "—", (methodCounts.get(o.payment_method ?? "—") ?? 0) + 1);
    titleCounts.set(o.payment_method_title ?? "—", (titleCounts.get(o.payment_method_title ?? "—") ?? 0) + 1);
    statusCounts.set(o.status ?? "—", (statusCounts.get(o.status ?? "—") ?? 0) + 1);
    for (const m of o.meta_data ?? []) if (m.key && PAYMENT_KEY_RE.test(m.key)) metaKeyCounts.set(m.key, (metaKeyCounts.get(m.key) ?? 0) + 1);
  }

  const dump = (m: Map<string, number>, title: string) => {
    console.log(`## ${title}`);
    [...m.entries()].sort((a, b) => b[1] - a[1]).forEach(([k, n]) => console.log(`  ${n}×  ${k}`));
    console.log("");
  };
  dump(statusCounts, "Наблюдаемые status slug");
  dump(methodCounts, "Наблюдаемые payment_method (ID)");
  dump(titleCounts, "Наблюдаемые payment_method_title");
  dump(metaKeyCounts, "Платёжные meta-ключи (имена, частота)");

  // Сравнительная выборка: до 2 примеров на категорию.
  const order = ["AIRWALLEX_PENDING_CANDIDATE", "NORMAL_PENDING", "AIRWALLEX_SUCCESS", "NORMAL_PAID", "FAILED/CANCELLED", "REFUNDED"];
  console.log("## Сравнительные образцы (обезличенные, до 2 на категорию)");
  console.log("cat | orderId | date | status | payment_method | payment_method_title | txn? | safe payment meta");
  for (const cat of order) {
    for (const o of (buckets.get(cat) ?? []).slice(0, 2)) {
      const date = (o.date_created_gmt ?? "").slice(0, 10);
      const txn = o.transaction_id && o.transaction_id.trim() ? "yes" : "no";
      const meta = safePaymentMeta(o.meta_data).map((x) => `${x.key}=${x.value}`).join("; ") || "—";
      console.log(`${cat} | ${o.id} | ${date} | ${o.status} | ${o.payment_method ?? "—"} | ${o.payment_method_title ?? "—"} | ${txn} | ${meta}`);
    }
  }
  console.log("\n# Готово. Скопируйте вывод (он уже обезличен) для обновления классификатора.");
}

main().catch((err) => {
  // Ошибку выводим БЕЗ payload/секретов.
  console.error("Анализ прерван:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
