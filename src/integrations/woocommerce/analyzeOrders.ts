import "server-only";
/**
 * READ-ONLY анализ старых WooCommerce-заказов через СОХРАНЁННОЕ подключение (по siteId).
 *
 * СТРОГО только чтение:
 *  - resolveWooCredentials → prisma.wooCommerceConnection.findUnique (READ);
 *  - loadWooIngestConfig   → prisma.wooCommerceConnection.findUnique (READ);
 *  - wooGet(/orders)       → HTTP GET к WooCommerce (READ);
 *  - classifyWooPayment / safePaymentMeta → чистые функции.
 *
 * ЗАПРЕЩЕНО (и НЕ вызывается здесь): prisma.create/update/upsert/delete, outbox.enqueue,
 * ingestWooOrder, syncWooOrders, registerWooWebhooks, любое создание Order/Product/
 * OutboxEvent/WooCommerceWebhook/SiteSync. Вывод обезличен (redact).
 */
import { resolveWooCredentials } from "./credentials";
import { loadWooIngestConfig } from "./config";
import { wooGet } from "./client";
import { classifyWooPayment, type WooOrderForPayment } from "./payment";
import { safePaymentMeta, PAYMENT_KEY_RE, type WooMeta } from "./redact";

const HARD_MAX = 50; // жёсткий предел выборки

type WooOrder = WooOrderForPayment & {
  id: number | string;
  date_created_gmt?: string;
};

export type AnalyzedSample = {
  category: string;
  orderId: string;
  date: string; // только дата (YYYY-MM-DD)
  status: string;
  paymentMethod: string;
  paymentMethodTitle: string;
  hasTransactionId: boolean;
  paymentMetaKeys: string[]; // только имена платёжных meta-ключей
  safeMetaValues: { key: string; value: string }[]; // обезличенные одно-токенные значения
  currentClassification: string; // вердикт ТЕКУЩЕГО классификатора (для сравнения)
};

export type AnalyzeResult = {
  storeUrl: string;
  fetched: number;
  totalInStore: number | null;
  statusCounts: [string, number][];
  paymentMethodCounts: [string, number][];
  paymentMethodTitleCounts: [string, number][];
  paymentMetaKeyCounts: [string, number][];
  samples: AnalyzedSample[];
};

function airwallexKlarnaSignals(o: WooOrder): { keys: string[]; isMethod: boolean; isTitle: boolean } {
  const keys = (o.meta_data ?? [])
    .map((m: WooMeta) => m.key ?? "")
    .filter((k) => /airwallex|klarna|pay_?later|intent|bnpl/i.test(k));
  const isMethod = /airwallex|klarna/i.test(o.payment_method ?? "");
  const isTitle = /klarna|pay\s*later|airwallex/i.test(o.payment_method_title ?? "");
  return { keys, isMethod, isTitle };
}

function categorize(o: WooOrder, sig: ReturnType<typeof airwallexKlarnaSignals>): string {
  const s = (o.status ?? "").toLowerCase();
  if (s === "refunded") return "REFUNDED";
  if (s === "failed" || s === "cancelled") return "FAILED/CANCELLED";
  if (s === "completed" || s === "processing") return sig.isMethod || sig.isTitle ? "AIRWALLEX_SUCCESS" : "NORMAL_PAID";
  if (sig.isMethod || sig.isTitle || sig.keys.length) return "AIRWALLEX_PENDING_CANDIDATE";
  return "NORMAL_PENDING";
}

function bump(m: Map<string, number>, k: string) {
  m.set(k, (m.get(k) ?? 0) + 1);
}
const sorted = (m: Map<string, number>): [string, number][] => [...m.entries()].sort((a, b) => b[1] - a[1]);

/**
 * Выполняет read-only анализ. `limit` жёстко ограничен HARD_MAX=50. Ничего не пишет.
 * `client` инъектируется в тестах (мок GET); в проде — реальный fetch.
 */
export async function analyzeWooOrders(
  siteId: string,
  opts: { limit?: number; client?: Parameters<typeof wooGet>[3] } = {}
): Promise<AnalyzeResult> {
  const limit = Math.min(Math.max(1, opts.limit ?? HARD_MAX), HARD_MAX);
  const creds = await resolveWooCredentials(siteId); // READ
  const config = await loadWooIngestConfig(siteId); // READ

  const { data: orders, total } = await wooGet<WooOrder[]>(
    creds,
    "/orders",
    { per_page: limit, orderby: "date", order: "desc" },
    opts.client
  ); // GET

  const statusCounts = new Map<string, number>();
  const methodCounts = new Map<string, number>();
  const titleCounts = new Map<string, number>();
  const metaKeyCounts = new Map<string, number>();
  const byCat = new Map<string, AnalyzedSample[]>();

  for (const o of orders ?? []) {
    const sig = airwallexKlarnaSignals(o);
    const cat = categorize(o, sig);
    bump(statusCounts, o.status ?? "—");
    bump(methodCounts, o.payment_method ?? "—");
    bump(titleCounts, o.payment_method_title ?? "—");
    for (const m of o.meta_data ?? []) if (m.key && PAYMENT_KEY_RE.test(m.key)) bump(metaKeyCounts, m.key);

    const cls = classifyWooPayment(o, config.payment); // чистая функция
    const sample: AnalyzedSample = {
      category: cat,
      orderId: String(o.id),
      date: (o.date_created_gmt ?? "").slice(0, 10),
      status: o.status ?? "—",
      paymentMethod: o.payment_method ?? "—",
      paymentMethodTitle: o.payment_method_title ?? "—",
      hasTransactionId: !!(o.transaction_id && o.transaction_id.trim()),
      paymentMetaKeys: sig.keys,
      safeMetaValues: safePaymentMeta(o.meta_data),
      currentClassification: cls.classification,
    };
    if (!byCat.has(cat)) byCat.set(cat, []);
    byCat.get(cat)!.push(sample);
  }

  // До 2 обезличенных примеров на категорию (сравнительная выборка).
  const order = ["AIRWALLEX_PENDING_CANDIDATE", "NORMAL_PENDING", "AIRWALLEX_SUCCESS", "NORMAL_PAID", "FAILED/CANCELLED", "REFUNDED"];
  const samples: AnalyzedSample[] = [];
  for (const cat of order) for (const s of (byCat.get(cat) ?? []).slice(0, 2)) samples.push(s);

  return {
    storeUrl: creds.storeUrl,
    fetched: orders?.length ?? 0,
    totalInStore: total,
    statusCounts: sorted(statusCounts),
    paymentMethodCounts: sorted(methodCounts),
    paymentMethodTitleCounts: sorted(titleCounts),
    paymentMetaKeyCounts: sorted(metaKeyCounts),
    samples,
  };
}
