/**
 * Что заказчик ввёл в форме оформления Woo — день, окно, получатель, адрес, открытка. Один разбор на
 * создание заказа и на его ОПЛАТУ (`retakeOnPaid`), чтобы два пути не разошлись.
 *
 * Зачем второе чтение. THEFLOW-21248 (15.10.2026): первая оплата не прошла, WooCommerce всё равно
 * создал заказ (Failed) — мы завели его с 16-м. Клиент оплатил ТОТ ЖЕ заказ повторной отправкой
 * формы, уже с 15-м, и получил письмо «October 15». Приём обновления поля формы не перечитывал (чтобы
 * сайт не перетирал перенос, сделанный у нас), и заказ остался на 16-м — дне неудачной попытки.
 * Оплата — момент, когда клиент подтвердил форму: что в ней тогда стоит, то он и заказал.
 */
import type { NormalizedOrder } from "@/integrations/normalized";
import type { ResolvedMetaFields } from "./orderMeta";
import { parseLocalDayToUtcMidnight } from "@/lib/tz";
import { parseWindowText } from "@/lib/deliveryWindow";
import { cleanCardMessage } from "@/integrations/cardMessageTail";

export type CheckoutFields = {
  /** Явно выбранный день; null — сайт день не прислал (создание тогда берёт день оформления). */
  deliveryDate: Date | null;
  deliveryWindow: string;
  windowFrom: number | null;
  windowTo: number | null;
  recipientName: string;
  recipientPhone: string;
  addressLine: string;
  apartment: string | null;
  city: string;
  zip: string;
  cardMessage: string;
  originalCardMessage: string;
};

export function checkoutFieldsOf(mapped: ResolvedMetaFields, normalized: NormalizedOrder): CheckoutFields {
  const windowText = mapped.deliveryWindow ?? normalized.deliveryWindow ?? "";
  const win = parseWindowText(windowText);
  // Тот же мусор магазина, что и у Shopify: служебный хвост приложения доставки и
  // HTML-сущности. См. cardMessageTail.ts. Сырой текст остаётся в originalCardMessage.
  const rawCardMessage = mapped.cardMessage ?? normalized.cardMessage ?? "";
  const addr = normalized.shippingAddress;
  return {
    deliveryDate: parseLocalDayToUtcMidnight(mapped.deliveryDate) ?? parseLocalDayToUtcMidnight(normalized.deliveryDate),
    deliveryWindow: windowText,
    // Окно строго «с — до»: слоты плагина («11:00 - 15:00») разбираются надёжно.
    windowFrom: win?.from ?? null,
    windowTo: win?.to ?? null,
    recipientName: mapped.recipientName ?? normalized.recipient.name,
    recipientPhone: mapped.recipientPhone ?? normalized.recipient.phone ?? "",
    addressLine: addr?.line1 ?? "",
    apartment: mapped.apartment ?? addr?.line2 ?? null,
    city: addr?.city ?? "",
    zip: addr?.zip ?? "",
    cardMessage: cleanCardMessage(rawCardMessage),
    originalCardMessage: rawCardMessage,
  };
}

type Ours = Omit<CheckoutFields, "deliveryDate" | "originalCardMessage"> & { deliveryDate: Date };
export type Retake = {
  data: Partial<Omit<CheckoutFields, "deliveryDate">> & { deliveryDate?: Date };
  dateChanged: boolean;
  deliveryChanged: boolean;
  contactsChanged: boolean;
};

const same = (a: string | null | undefined, b: string | null | undefined) => (a ?? "").trim() === (b ?? "").trim();

/**
 * Что взять из оплаченной формы. Блок, который у нас правил человек (`OrderAudit.block`), не
 * трогаем: его решение главнее формы. Перенос ИИ строки аудита не пишет, но на сайтах с плагином
 * доставки он сам уходит в заказ Woo (`woo.delivery.push`), и форма с ним совпадает.
 */
export function retakeOnPaid(ours: Ours, site: CheckoutFields, editedBlocks: ReadonlySet<string>): Retake {
  const data: Retake["data"] = {};
  if (!editedBlocks.has("delivery")) {
    if (site.deliveryDate && site.deliveryDate.getTime() !== ours.deliveryDate.getTime()) data.deliveryDate = site.deliveryDate;
    const windowDiffers = site.windowFrom != null
      ? site.windowFrom !== ours.windowFrom || site.windowTo !== ours.windowTo
      : !!site.deliveryWindow.trim() && !same(site.deliveryWindow, ours.deliveryWindow);
    if (windowDiffers) Object.assign(data, { deliveryWindow: site.deliveryWindow, windowFrom: site.windowFrom, windowTo: site.windowTo });
  }
  let contactsChanged = false;
  if (!editedBlocks.has("contacts")) {
    for (const k of ["recipientName", "recipientPhone", "addressLine", "apartment", "city", "zip"] as const) {
      if (!same(site[k], ours[k])) {
        Object.assign(data, { [k]: site[k] });
        contactsChanged = true;
      }
    }
  }
  if (!editedBlocks.has("cardNote") && !same(site.cardMessage, ours.cardMessage)) {
    Object.assign(data, { cardMessage: site.cardMessage, originalCardMessage: site.originalCardMessage });
  }
  return {
    data,
    dateChanged: "deliveryDate" in data,
    deliveryChanged: "deliveryDate" in data || "deliveryWindow" in data,
    contactsChanged,
  };
}
