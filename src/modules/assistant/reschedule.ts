/**
 * Клиент словами перенёс доставку с утра на после 15:00 — меняем окно в заказе сами.
 *
 * Решение владельца (27.09.2026): «надо менять время». Раньше слова клиента попадали только в
 * заметку («готов принять after 5pm»), а окно оставалось утренним: флорист планировал утро,
 * загрузка утра держала место, сайт TheFlow держал утренний слот закрытым.
 *
 * Меняем УЗКО — только то, что ассистенту и так разрешено подтверждать без человека: более
 * позднее время В ТОТ ЖЕ день. Другой день, раннее время, «any time» — не трогаем.
 *
 * Чистая функция — решение и новое окно; побочные эффекты делает handler.
 */
import { windowIsMorning, wishIsAfternoon } from "@/modules/capacity/morning";

/** Слова про другой день: такой перенос решает человек. */
const OTHER_DAY = /\b(tomorrow|tmrw|monday|tuesday|wednesday|thursday|friday|saturday|sunday|next week|\d{1,2}[/.]\d{1,2})\b/i;

export function laterWindowFromWish(currentWindow: string | null, readyTime: string): string | null {
  if (!windowIsMorning(currentWindow)) return null;
  if (OTHER_DAY.test(readyTime)) return null;
  if (!wishIsAfternoon(readyTime)) return null;
  // Окно в карточке — слова клиента, как владелец и сам их пишет («4.30 - 5pm», «after 5pm»).
  const window = readyTime.replace(/\b(today|tonight)\b/gi, "").replace(/\s+/g, " ").trim();
  return window || null;
}
