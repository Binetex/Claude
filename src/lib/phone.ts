/**
 * Приводит телефон к виду с кодом страны: если он уже начинается с "+" — не трогаем
 * (уже есть код страны), иначе добавляем код по умолчанию "+1" (США/Канада — основной
 * рынок Floremart). Прочее форматирование (скобки/дефисы/пробелы) снимается.
 */
export function normalizePhone(raw: string | null | undefined): string {
  const value = (raw ?? "").trim();
  if (!value) return "";
  if (value.startsWith("+")) return value;

  const digits = value.replace(/\D/g, "");
  if (!digits) return value; // не похоже на номер — не трогаем как есть

  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return `+1${digits}`;
}

/**
 * Строгая нормализация в E.164 для СОПОСТАВЛЕНИЯ (matching) и хранения `*Normalized`.
 * Возвращает `+` + только цифры (8–15 знаков) либо null, если это не похоже на телефон.
 * Оба сравниваемых номера (заказа и события QUO) прогоняются через эту же функцию.
 * Примеры: "(310) 555-1234" → "+13105551234"; "+1 310 555 1234" → "+13105551234".
 */
export function toE164(raw: string | null | undefined): string | null {
  const norm = normalizePhone(raw);
  if (!norm.startsWith("+")) return null;
  const digits = norm.slice(1).replace(/\D/g, "");
  if (digits.length < 8 || digits.length > 15) return null; // E.164: макс. 15 цифр
  return `+${digits}`;
}
