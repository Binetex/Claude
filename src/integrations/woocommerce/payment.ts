/**
 * Классификация платежа WooCommerce-заказа с учётом Airwallex / Klarna Pay Later (BNPL).
 * Чистая функция (без сети/БД) — тестируема. Ничего не хардкодим: признаки BNPL и meta-ключи
 * берём из конфигурации конкретного Site (WooCommerceConnection).
 *
 * Почему нельзя опираться только на WooCommerce `status`:
 *  при Klarna Pay Later / отложенной оплате заказ может оставаться `pending` (или в Airwallex-
 *  специфичном pending-состоянии), хотя это ВАЛИДНЫЙ заказ, который нужно принять в работу.
 *
 * Безопасность: если BNPL-статус нельзя однозначно подтвердить — НЕ считаем оплаченным,
 * ставим PAYMENT_PENDING/UNKNOWN, флористу автоматически не отдаём, показываем предупреждение.
 * Совпадение только по названию (title содержит "Klarna") НЕ считается подтверждением.
 */
import type { PaymentStatus } from "@/generated/prisma/enums";

export type WooPaymentClass =
  | "PAID"
  | "PAY_LATER_APPROVED"
  | "PAYMENT_PENDING"
  | "PAYMENT_FAILED"
  | "REFUNDED"
  | "UNKNOWN";

export type WooMeta = { key?: string; value?: unknown };

export type WooOrderForPayment = {
  status?: string;
  payment_method?: string;
  payment_method_title?: string;
  transaction_id?: string;
  date_created_gmt?: string;
  date_paid_gmt?: string | null;
  meta_data?: WooMeta[];
};

/** Конфигурация BNPL для Site (из WooCommerceConnection). */
export type AirwallexMetaConfig = {
  /** Woo meta key, где Airwallex хранит статус payment intent. */
  paymentIntentStatusKey?: string;
  /** Значения статуса, означающие подтверждённую авторизацию/оплату (регистр не важен). */
  approvedValues?: string[];
  /** Значения статуса, означающие отказ. */
  failedValues?: string[];
};

export type WooPaymentConfig = {
  airwallexEnabled: boolean;
  klarnaPayLaterPendingIsConfirmed: boolean;
  /** payment_method IDs, считающиеся Airwallex/BNPL (напр. "airwallex_klarna"). */
  airwallexPaymentMethodIds: string[];
  airwallexMetaKeys: AirwallexMetaConfig | null;
  /** Максимум минут ожидания финального статуса, после — предупреждение о зависшем pending. */
  payLaterMaxWaitMinutes: number;
  /** Поведение при UNKNOWN: HOLD (держать, не отдавать) | AWAITING_PAYMENT. */
  unknownBehavior: "HOLD" | "AWAITING_PAYMENT";
};

export type WooPaymentResult = {
  classification: WooPaymentClass;
  paymentStatus: PaymentStatus;
  /** Можно ли отдавать заказ флористу / запускать изготовление. */
  workable: boolean;
  /** Безопасное предупреждение владельцу (без PII), либо null. */
  warning: string | null;
  /** Это настроенный BNPL-метод (Airwallex/Klarna). Отличает «ждём подтверждения» от «просто не оплачен». */
  payLater: boolean;
};

const DEFAULT_APPROVED = ["AUTHORIZED", "SUCCEEDED", "APPROVED", "PAID", "CAPTURED", "COMPLETED"];
const DEFAULT_FAILED = ["FAILED", "CANCELLED", "CANCELED", "DECLINED", "EXPIRED", "VOIDED"];

function metaVal(order: WooOrderForPayment, key: string | undefined): string | null {
  if (!key) return null;
  const hit = order.meta_data?.find((m) => m.key === key);
  return hit && hit.value != null ? String(hit.value).trim() : null;
}

/** Является ли payment_method настроенным Airwallex/BNPL-методом (по ID, НЕ по названию). */
function isConfiguredBnplMethod(order: WooOrderForPayment, cfg: WooPaymentConfig): boolean {
  if (!cfg.airwallexEnabled) return false;
  const pm = (order.payment_method ?? "").trim();
  if (!pm) return false;
  return cfg.airwallexPaymentMethodIds.map((s) => s.trim()).includes(pm);
}

/** Оценка Airwallex payment-intent статуса по meta: "approved" | "failed" | "unknown" | "absent". */
function airwallexIntentEvidence(order: WooOrderForPayment, cfg: WooPaymentConfig): "approved" | "failed" | "unknown" | "absent" {
  const keyCfg = cfg.airwallexMetaKeys ?? {};
  const raw = metaVal(order, keyCfg.paymentIntentStatusKey);
  if (!raw) return "absent";
  const v = raw.toUpperCase();
  const approved = (keyCfg.approvedValues ?? DEFAULT_APPROVED).map((s) => s.toUpperCase());
  const failed = (keyCfg.failedValues ?? DEFAULT_FAILED).map((s) => s.toUpperCase());
  if (approved.includes(v)) return "approved";
  if (failed.includes(v)) return "failed";
  return "unknown";
}

function minutesSince(iso: string | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso.endsWith("Z") || iso.includes("+") ? iso : `${iso}Z`);
  if (!Number.isFinite(t)) return null;
  return (Date.now() - t) / 60000;
}

function result(
  classification: WooPaymentClass,
  paymentStatus: PaymentStatus,
  workable: boolean,
  warning: string | null,
  payLater = false
): WooPaymentResult {
  return { classification, paymentStatus, workable, warning, payLater };
}

/**
 * Классифицирует платёж заказа. `now`-зависимость только через minutesSince (для warning о
 * зависшем pending) — на детерминизм классификации не влияет.
 */
export function classifyWooPayment(order: WooOrderForPayment, cfg: WooPaymentConfig): WooPaymentResult {
  const status = (order.status ?? "").toLowerCase();

  // 1) Терминальные/однозначные Woo-статусы — приоритетнее любых BNPL-эвристик.
  if (status === "refunded") return result("REFUNDED", "REFUNDED", false, null);
  if (status === "completed" || status === "processing") return result("PAID", "PAID", true, null);
  if (status === "failed") return result("PAYMENT_FAILED", "UNPAID", false, "WooCommerce отметил оплату как failed.");
  if (status === "cancelled") return result("PAYMENT_FAILED", "UNPAID", false, null);

  // 2) pending / on-hold: разбираем возможный BNPL (Airwallex/Klarna Pay Later).
  const bnpl = isConfiguredBnplMethod(order, cfg);
  if (!bnpl) {
    // Обычный неоплаченный заказ — флористу не отдаём, не считаем просроченной неоплатой отдельно.
    return result("PAYMENT_PENDING", "UNPAID", false, null);
  }

  // Это настроенный BNPL-метод. Ищем подтверждение авторизации.
  const evidence = airwallexIntentEvidence(order, cfg);
  const hasTxn = !!(order.transaction_id && order.transaction_id.trim());
  const stalePending = (() => {
    const mins = minutesSince(order.date_created_gmt);
    return mins != null && mins > cfg.payLaterMaxWaitMinutes;
  })();

  if (evidence === "approved") {
    return result("PAY_LATER_APPROVED", "PAY_LATER_APPROVED", true, null, true);
  }
  if (evidence === "failed") {
    return result("PAYMENT_FAILED", "UNPAID", false, "Airwallex/Klarna сообщил об отказе в оплате.", true);
  }

  if (evidence === "unknown") {
    // Есть BNPL-статус, но значение не распознано — не гадаем, флористу НЕ отдаём.
    // unknownBehavior влияет только на формулировку/строгость предупреждения (workable=false в обоих).
    const base = "Airwallex/Klarna вернул неизвестный платёжный статус — требуется ручная проверка перед передачей флористу.";
    const warn =
      (cfg.unknownBehavior === "HOLD" ? `Заказ удержан: ${base}` : base) + (stalePending ? " Ожидание превысило заданный лимит." : "");
    return result("UNKNOWN", "UNPAID", false, warn, true);
  }

  // evidence === "absent": прямого подтверждения из meta нет.
  if (hasTxn) {
    // Есть transaction_id (обычно проставляется при авторизации BNPL) — считаем одобренным,
    // но помечаем предупреждением, что подтверждение косвенное.
    return result("PAY_LATER_APPROVED", "PAY_LATER_APPROVED", true, "Оплата позже: подтверждена по transaction_id (без явного статуса Airwallex).", true);
  }
  if (cfg.klarnaPayLaterPendingIsConfirmed) {
    // Владелец явно доверяет: pending этого BNPL-метода = одобрено.
    return result("PAY_LATER_APPROVED", "PAY_LATER_APPROVED", true, "Оплата позже: принято по настройке магазина (pending BNPL = одобрено).", true);
  }

  // Подтвердить нельзя — безопасный путь: не отдаём флористу, предупреждаем.
  const warn =
    "Klarna/BNPL заказ в статусе pending без подтверждения оплаты — не передавать флористу до ручной проверки." +
    (stalePending ? " Ожидание превысило заданный лимит." : "");
  return result("PAYMENT_PENDING", "UNPAID", false, warn, true);
}
