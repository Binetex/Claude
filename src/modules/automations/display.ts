/** Человекочитаемые подписи для UI (чистый модуль, годится и на сервере, и в клиенте). */

export function audienceLabel(a: string): string {
  return a === "CUSTOMER" ? "Заказчик" : a === "RECIPIENT" ? "Получатель" : a === "BOTH" ? "Оба" : a;
}

const UNIT_RU: Record<string, [string, string, string]> = {
  MINUTE: ["минуту", "минуты", "минут"],
  HOUR: ["час", "часа", "часов"],
  DAY: ["день", "дня", "дней"],
  WEEK: ["неделю", "недели", "недель"],
  MONTH: ["месяц", "месяца", "месяцев"],
};

function plural(n: number, forms: [string, string, string]): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return forms[0];
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return forms[1];
  return forms[2];
}

export function delayLabel(amount: number, unit: string): string {
  if (unit === "IMMEDIATE" || amount <= 0) return "Сразу";
  const forms = UNIT_RU[unit];
  if (!forms) return `${amount} ${unit}`;
  return `Через ${amount} ${plural(amount, forms)}`;
}

export function jobStatusLabel(s: string): string {
  switch (s) {
    case "SCHEDULED": return "Запланировано";
    case "PROCESSING": return "В обработке";
    case "SENT": return "Отправлено";
    case "SKIPPED": return "Пропущено";
    case "FAILED": return "Ошибка";
    case "CANCELLED": return "Отменено";
    default: return s;
  }
}

export function jobStatusClass(s: string): string {
  switch (s) {
    case "SENT": return "bg-emerald-100 text-emerald-800 border-emerald-200";
    case "SCHEDULED": return "bg-sky-100 text-sky-800 border-sky-200";
    case "PROCESSING": return "bg-indigo-100 text-indigo-800 border-indigo-200";
    case "SKIPPED": return "bg-slate-100 text-slate-600 border-slate-200";
    case "FAILED": return "bg-red-100 text-red-800 border-red-200";
    case "CANCELLED": return "bg-amber-100 text-amber-800 border-amber-200";
    default: return "bg-slate-100 text-slate-600 border-slate-200";
  }
}

/** Маскирует телефон для истории (не показываем полностью). */
export function maskPhoneDisplay(e164: string | null | undefined): string {
  if (!e164) return "—";
  if (e164.length <= 4) return "•".repeat(e164.length);
  return `${"•".repeat(Math.max(0, e164.length - 4))}${e164.slice(-4)}`;
}
