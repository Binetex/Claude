/**
 * Structured logging для QUO. НИКОГДА не пишем полный телефон, текст SMS, транскрипт, summary,
 * ключи/подписи. Только маскированные номера, длины и безопасные метки.
 */
export function maskPhone(p: string | null | undefined): string {
  if (!p) return "∅";
  const digits = p.replace(/\D/g, "");
  if (digits.length < 4) return "***";
  return `***${digits.slice(-4)}`;
}

/** Один structured-лог (JSON-строка). Значения предполагаются уже безопасными (без PII). */
export function quoLog(event: string, fields: Record<string, unknown> = {}): void {
  try {
    console.log(JSON.stringify({ ts: new Date().toISOString(), scope: "quo", event, ...fields }));
  } catch {
    console.log(`[quo] ${event}`);
  }
}
