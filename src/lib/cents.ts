/**
 * Единственная точка конвертации «доллары ↔ центы» для финансовых данных.
 *
 * Правила: деньги в БД — целые центы (Int); из формы приходит строка в USD с не более чем
 * двумя знаками. Разбор строгий: никакого parseFloat с молчаливым округлением, никаких
 * отрицательных значений, пустая строка — это «не задано», а не ноль.
 */

export class CentsParseError extends Error {}

/**
 * Строка USD → целые центы. Пустая строка и пробелы дают null («значение не задано»).
 * Принимает "12", "12.5", "12.50", "1,234.50". Отвергает всё остальное.
 */
export function usdToCents(input: string): number | null {
  const trimmed = input.trim().replace(/\s/g, "");
  if (trimmed === "") return null;
  // Запятые допускаются ТОЛЬКО как разделители тысяч: "1,234.50" — да, "12,5.5" — нет.
  // Снимать их безусловно нельзя: тогда мусор вида "1,2,3" тихо превратился бы в число.
  const valid = /^\d+(\.\d{1,2})?$/.test(trimmed) || /^\d{1,3}(,\d{3})+(\.\d{1,2})?$/.test(trimmed);
  if (!valid) {
    throw new CentsParseError("сумма должна быть неотрицательным числом с не более чем двумя знаками после точки");
  }
  const raw = trimmed.replace(/,/g, "");
  const [whole, frac = ""] = raw.split(".");
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents)) throw new CentsParseError("сумма слишком большая");
  return cents;
}

/** Центы → строка для поля ввода: 1200 → "12.00". null → "". */
export function centsToUsdInput(cents: number | null | undefined): string {
  if (cents == null) return "";
  return (cents / 100).toFixed(2);
}

/** Центы → отображение: 1200 → "$12.00". null → "—" (значение неизвестно, а не ноль). */
export function formatCents(cents: number | null | undefined): string {
  if (cents == null) return "—";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

const DOLLARS = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

/**
 * Центы → доллары без копеек: 113695 → "$1,137".
 *
 * ТОЛЬКО ДЛЯ ОБЗОРНЫХ ЭКРАНОВ, где числа читают глазами и сравнивают между собой: там
 * ".00" у каждой суммы съедает место, а на телефоне из-за него не помещается вся строка.
 *
 * Где сумма — это ОБЯЗАТЕЛЬСТВО (выплата флористу, запись в книге операций, возврат
 * клиенту, ввод в форме), обязан оставаться `formatCents`. Округлённая выплата — это
 * неверная выплата, и разница в 50 центов на экране против банковской выписки будет стоить
 * дороже, чем сэкономленное место.
 */
export function formatDollars(cents: number | null | undefined): string {
  if (cents == null) return "—";
  return DOLLARS.format(cents / 100);
}
