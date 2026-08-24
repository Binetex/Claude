/**
 * Подписи пометки о работе с клиентом. Обычный модуль (не "use client"): его читают и
 * серверная карточка колл-центра, и клиентский блок владельца — импортировать значение из
 * "use client"-модуля на сервере нельзя, придёт client-reference прокси.
 */
export const MARKETING_MARK_META = {
  MUTED: {
    label: "Не писать клиенту",
    short: "не писать",
    className: "bg-slate-200 text-slate-700",
  },
  ASK_REVIEW: {
    label: "Попросить отзыв",
    short: "попросить отзыв",
    className: "bg-amber-100 text-amber-900",
  },
} as const;
