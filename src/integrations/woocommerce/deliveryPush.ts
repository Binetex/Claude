/**
 * Перенос доставки — обратно в заказ WooCommerce, в поля плагина доставки.
 *
 * ЗАЧЕМ. На TheFlow утренний слот закрывает сам плагин доставки
 * (pi-woocommerce-order-date-time-and-type-pro): он считает заказы по датe и слоту, записанным
 * В ЗАКАЗЕ WOO (`pi_system_delivery_date` + `pi_delivery_time`). Перенос во Floremart туда не
 * доходил: приём Woo дату и окно после создания не трогает, а обратно мы их не писали. В итоге
 * перенесённый с утра заказ продолжал держать утренний слот на сайте закрытым.
 *
 * Пишем ТОЛЬКО четыре поля плагина. Статус, деньги, позиции — не наши. Woo на это ответит
 * вебхуком order.updated, но приём дату/окно не перезаписывает — петли нет.
 *
 * Чистая часть (слот и даты) — без сети, её проверяет тест.
 */
import { parseTimes } from "@/modules/capacity/morning";
import { wooRequest } from "./client";
import type { WooCredentials } from "./credentials";

/** Мета-ключ окна у сайтов с этим плагином — по нему узнаём, что писать есть куда. */
export const PI_WINDOW_META = "pi_delivery_time";

/**
 * Слоты плагина на TheFlow (`pi_general_time_slot_delivery`). Плагин считает заказы по строке
 * слота ДОСЛОВНО, поэтому произвольное окно из карточки («after 5pm», «4.30 - 5pm») приводим к
 * слоту, в котором оно начинается. Поменяются слоты в плагине — менять здесь.
 */
const PI_SLOTS = [
  { fromMin: 0, slot: "11:00 - 15:00", display: "11:00 AM - 3:00 PM" },
  { fromMin: 15 * 60, slot: "15:00 - 19:00", display: "3:00 PM - 7:00 PM" },
  { fromMin: 18 * 60, slot: "18:00 - 21:00", display: "6:00 PM - 9:00 PM" },
] as const;

export function piSlotFor(window: string | null | undefined): { slot: string; display: string } | null {
  const text = (window ?? "").trim();
  const exact = PI_SLOTS.find((s) => s.slot.replace(/\s/g, "") === text.replace(/\s/g, ""));
  if (exact) return { slot: exact.slot, display: exact.display };
  const times = parseTimes(text);
  if (!times.length) return null;
  // «before 5pm», «до 5 вечера» — окно на весь день до этого часа: слот по первому ЧИСЛУ был бы
  // вечерним. Такое окно начинается утром.
  const start = /\b(before|by|until|till)\b|\bдо\s/i.test(text) ? 0 : times[0];
  const hit = [...PI_SLOTS].reverse().find((s) => start >= s.fromMin)!;
  return { slot: hit.slot, display: hit.display };
}

/** Дата плагина: системная «2026/09/28» и показываемая «September 28, 2026». */
export function piDates(day: string): { system: string; display: string } {
  const d = new Date(`${day}T00:00:00Z`);
  return {
    system: day.replace(/-/g, "/"),
    display: new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "long", day: "numeric", year: "numeric" }).format(d),
  };
}

export async function pushWooDelivery(creds: WooCredentials, externalId: string, day: string, window: string): Promise<{ slot: string } | null> {
  const slot = piSlotFor(window);
  if (!slot) return null;
  const dates = piDates(day);
  await wooRequest(creds, `/orders/${encodeURIComponent(externalId)}`, {
    method: "PUT",
    body: {
      meta_data: [
        { key: "pi_system_delivery_date", value: dates.system },
        { key: "pi_delivery_date", value: dates.display },
        { key: "pi_delivery_time", value: slot.slot },
        { key: "pi_display_delivery_time", value: slot.display },
      ],
    },
  });
  return { slot: slot.slot };
}
