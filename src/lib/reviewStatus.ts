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
