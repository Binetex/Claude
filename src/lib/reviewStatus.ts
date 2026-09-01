/**
 * Подписи шагов воронки. Обычный модуль (не "use client"): их читают и серверные страницы, и
 * клиентские компоненты — импортировать значение из "use client"-модуля на сервере нельзя.
 */
export const REVIEW_STATUS_LABELS: Record<string, string> = {
  NEW: "ждёт звонка",
  CALLING: "звоним",
  LINK_SENT: "ссылка отправлена",
  PROMISED: "обещал оставить",
  FORGOT: "обещал и забыл",
  READY_TO_CHECK: "на проверке",
  CONFIRMED: "отзыв получен",
  DECLINED: "отказался",
  GAVE_UP: "не удалось",
};

/**
 * Цвет статуса. Один взгляд на очередь должен отвечать «где что»: серые плашки на всех
 * карточках читались как «статус вообще непонятно» (прямая жалоба владельца).
 */
export const REVIEW_STATUS_BADGE: Record<string, string> = {
  NEW: "border-sky-200 bg-sky-50 text-sky-800",
  CALLING: "border-amber-300 bg-amber-50 text-amber-900",
  LINK_SENT: "border-indigo-200 bg-indigo-50 text-indigo-800",
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
  PROMISED: "клиент обещал оставить отзыв",
  REMINDED: "отправлено напоминание",
  CONFIRMED: "отзыв засчитан",
  DECLINED: "клиент отказался",
  GAVE_UP: "закрыт: получить отзыв не удалось",
  LOCATION_CHANGED: "точка отзыва изменена",
  REOPENED: "возвращён в работу",
};
