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
