/**
 * Обезличивание при анализе реальных WooCommerce-заказов (read-only). Чистые функции.
 * Гарантируют, что наружу попадают только безопасные платёжные признаки — без имён, email,
 * телефонов, адресов, открыток, заметок, секретов и длинных id.
 */

/** Ключи meta, релевантные платежу/Airwallex/Klarna — их значения можно показывать (после PII-проверки). */
export const PAYMENT_KEY_RE = /(airwallex|klarna|payment|pay_?later|intent|transaction|txn|refund|capture|authoriz|charge|gateway|bnpl|status)/i;

/** Явно чувствительные ключи — значение не показываем никогда. */
export const PII_KEY_RE = /(name|email|phone|address|city|zip|postcode|first|last|card|message|note|customer|recipient|billing|shipping)/i;

/** Значение безопасно (не PII/не секрет): короткий токен без email/телефонов/длинных id/многословья. */
export function isSafeMetaValue(v: unknown): boolean {
  if (v == null) return false;
  if (typeof v === "object") return false;
  const s = String(v);
  if (s.length === 0 || s.length > 40) return false;
  if (/\s/.test(s)) return false; // любой пробел → многословный текст (имена/сообщения/адрес) — режем
  if (s.includes("@")) return false; // email
  if (/\d{7,}/.test(s.replace(/[^\d]/g, ""))) return false; // телефон/длинные id
  if (!/^[A-Za-z0-9_.\-:/]+$/.test(s)) return false; // только одно-токенные «статус-подобные» значения
  return true;
}

export type WooMeta = { key?: string; value?: unknown };

/** Безопасные значения платёжных meta: только payment-релевантные ключи, не PII-ключи, безопасное значение. */
export function safePaymentMeta(meta: WooMeta[] | undefined): { key: string; value: string }[] {
  const out: { key: string; value: string }[] = [];
  for (const m of meta ?? []) {
    const k = m.key ?? "";
    if (!PAYMENT_KEY_RE.test(k) || PII_KEY_RE.test(k)) continue;
    if (isSafeMetaValue(m.value)) out.push({ key: k, value: String(m.value) });
  }
  return out;
}
