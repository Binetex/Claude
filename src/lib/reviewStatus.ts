/**
 * Подписи шагов воронки. Обычный модуль (не "use client"): их читают и серверные страницы, и
 * клиентские компоненты — импортировать значение из "use client"-модуля на сервере нельзя.
 */
export const REVIEW_STATUS_LABELS: Record<string, string> = {
  NEW: "ждёт звонка",
  CALLING: "звоним",
  LINK_SENT: "ссылка отправлена",
  IGNORING: "игнорирует",
  REPLIED: "клиент ответил",
  PROMISED: "обещал оставить",
  FORGOT: "обещал и забыл",
  READY_TO_CHECK: "на проверке",
  CONFIRMED: "отзыв получен",
  DECLINED: "отказался",
  GAVE_UP: "не удалось",
};

/**
 * Статус ЧЕЛОВЕЧЕСКОЙ фразой — то, что владелец спрашивает первым: «а что с ним сейчас?».
 * Короткая подпись выше отвечает «на каком шаге», а это — «что происходит»: «ещё не звонили»
 * понятнее, чем «ждёт звонка», а у звонков видно, сколько попыток осталось.
 */
export function reviewStatusText(status: string, callAttempts: number, maxAttempts: number): string {
  switch (status) {
    case "NEW":
      return "ещё не звонили";
    case "CALLING":
      return `звоним, попытка ${Math.min(callAttempts + 1, maxAttempts)} из ${maxAttempts}`;
    case "LINK_SENT":
      return "ссылка отправлена, ждём клиента";
    case "IGNORING":
      return "игнорирует: ссылка у него, ответа нет";
    case "REPLIED":
      return "клиент ответил — ход за вами";
    case "PROMISED":
      return "обещал оставить отзыв";
    case "FORGOT":
      return "обещал и забыл, напомнили";
    case "READY_TO_CHECK":
      return "говорит, что оставил — проверить";
    case "CONFIRMED":
      return "отзыв получен";
    case "DECLINED":
      return "клиент отказался";
    case "GAVE_UP":
      return "получить отзыв не удалось";
    default:
      return REVIEW_STATUS_LABELS[status] ?? status;
  }
}

/**
 * Цвет статуса. Один взгляд на очередь должен отвечать «где что»: серые плашки на всех
 * карточках читались как «статус вообще непонятно» (прямая жалоба владельца).
 */
export const REVIEW_STATUS_BADGE: Record<string, string> = {
  NEW: "border-sky-200 bg-sky-50 text-sky-800",
  CALLING: "border-amber-300 bg-amber-50 text-amber-900",
  LINK_SENT: "border-indigo-200 bg-indigo-50 text-indigo-800",
  // «Игнорирует» — не тревога, а факт: серым, чтобы не соревноваться с просрочкой.
  IGNORING: "border-slate-300 bg-slate-100 text-slate-700",
  // «Ответил» — единственное, что требует человека прямо сейчас.
  REPLIED: "border-amber-300 bg-amber-50 text-amber-900",
  PROMISED: "border-violet-200 bg-violet-50 text-violet-800",
  FORGOT: "border-orange-300 bg-orange-50 text-orange-900",
  READY_TO_CHECK: "border-teal-300 bg-teal-50 text-teal-900",
  CONFIRMED: "border-emerald-300 bg-emerald-50 text-emerald-900",
  DECLINED: "border-slate-200 bg-slate-100 text-slate-600",
  GAVE_UP: "border-slate-200 bg-slate-100 text-slate-600",
};

/** Подписи событий журнала — человеческими словами, без словаря enum'ов. */
export const REVIEW_EVENT_LABELS: Record<string, string> = {
  CREATED: "запрос создан",
  CALL_NO_ANSWER: "звонок: не дозвонились",
  CALL_TALKED: "звонок: поговорили",
  CLAIMED: "клиент сказал, что оставил отзыв",
  LINK_SENT: "ссылка отправлена",
  LINK_FAILED: "ссылку отправить не удалось",
  IGNORED: "клиент не отвечает больше суток",
  REPLIED: "клиент ответил",
  PROMISED: "клиент обещал оставить отзыв",
  REMINDED: "отправлено напоминание",
  CONFIRMED: "отзыв засчитан",
  DECLINED: "клиент отказался",
  GAVE_UP: "закрыт: получить отзыв не удалось",
  LOCATION_CHANGED: "точка отзыва изменена",
  REOPENED: "возвращён в работу",
};
