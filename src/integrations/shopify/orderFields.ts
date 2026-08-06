/**
 * Чистые мапперы полей Shopify-заказа (без server-only) — тестируются напрямую.
 * Разделение источников: номер = name; адрес отправителя = billing_address;
 * инструкции доставки = GraphQL deliveryMethod (native Local Delivery). См. orderFields.test.ts.
 */
import { normalizePhone } from "@/lib/phone";

export type ShopifyBillingAddress =
  | {
      address1?: string | null;
      address2?: string | null;
      city?: string | null;
      province_code?: string | null;
      province?: string | null;
      zip?: string | null;
      country_code?: string | null;
    }
  | null
  | undefined;

/**
 * Клиентский номер заказа Shopify — в `name` ("#41308"), а НЕ в `order_number` (внутренний
 * счётчик, у этого магазина 1308). Берём name без ведущего "#"; при отсутствии — order_number;
 * иначе externalId. UI сам добавит "#" (formatOrderNumber).
 */
export function extractShopifyOrderNumber(
  name: string | null | undefined,
  orderNumber: number | string | null | undefined,
  externalId: string
): string {
  const fromName = typeof name === "string" ? name.trim().replace(/^#+/, "").trim() : "";
  if (fromName) return fromName;
  if (orderNumber != null && String(orderNumber).trim() !== "") return String(orderNumber);
  return externalId;
}

/** Адрес отправителя (billing) из Shopify billing_address. Пустые поля → null (не ""). */
export function extractSenderAddress(billing: ShopifyBillingAddress) {
  const s = (v: string | null | undefined) => (typeof v === "string" && v.trim() ? v.trim() : null);
  return {
    senderAddressLine: s(billing?.address1),
    senderApartment: s(billing?.address2),
    senderCity: s(billing?.city),
    senderProvince: s(billing?.province_code ?? billing?.province),
    senderZip: s(billing?.zip),
    senderCountry: s(billing?.country_code),
  };
}

export type SenderAddress = ReturnType<typeof extractSenderAddress>;

/** Ровно те части заказа Shopify, из которых складывается личность заказчика. */
export type SenderIdentitySource = {
  /** Телефон уровня ЗАКАЗА — тот, что клиент указал на оформлении. */
  phone?: string | null;
  customer?: { first_name?: string; last_name?: string; phone?: string } | null;
  billing_address?: { name?: string; first_name?: string; last_name?: string; phone?: string } | null;
};

/**
 * Имя и телефон ЗАКАЗЧИКА — того, кто оформил заказ.
 *
 * Раньше и то и другое брали из billing_address, а `customer` шёл лишь запасным вариантом
 * через `||`. Платёжный адрес почти всегда заполнен, поэтому до `customer` дело не доходило
 * никогда, и в заказах, где клиент подставил в платёжный адрес данные ПОЛУЧАТЕЛЯ, телефон
 * заказчика терялся молча (PAR-41318: заказывала Jamella с номером +1 347…, а у нас
 * записался Aspen с номером +1 864…, и связаться с заказчицей было не по чему).
 *
 * Теперь личность берётся из `customer` — это учётная запись, оформившая заказ, — а
 * billing остаётся последним запасным. Телефон: сначала телефон ЗАКАЗА (что клиент ввёл на
 * оформлении), потом телефон учётной записи, и только потом платёжный адрес.
 *
 * Получателя это не касается: его имя и телефон по-прежнему из shipping_address.
 */
export function extractSenderIdentity(payload: SenderIdentitySource): { senderName: string; senderPhone: string } {
  const t = (v: string | null | undefined) => (typeof v === "string" ? v.trim() : "");
  const joined = (a: string | null | undefined, b: string | null | undefined) =>
    [t(a), t(b)].filter(Boolean).join(" ");

  const billing = payload.billing_address;
  const senderName =
    joined(payload.customer?.first_name, payload.customer?.last_name) ||
    t(billing?.name) ||
    joined(billing?.first_name, billing?.last_name) ||
    "—";

  const senderPhone = normalizePhone(t(payload.phone) || t(payload.customer?.phone) || t(billing?.phone));

  return { senderName, senderPhone };
}

/** Есть ли у отправителя адрес (для UI: показывать адрес или «не указан»). */
export function hasSenderAddress(a: SenderAddress): boolean {
  return !!(a.senderAddressLine || a.senderCity || a.senderZip || a.senderProvince || a.senderCountry);
}

/** Одна аккуратная строка адреса отправителя (для карточки). Пусто → null. */
export function formatSenderAddress(a: SenderAddress): string | null {
  if (!hasSenderAddress(a)) return null;
  const line1 = [a.senderAddressLine, a.senderApartment].filter(Boolean).join(", ");
  const line2 = [a.senderCity, a.senderProvince, a.senderZip].filter(Boolean).join(" ");
  return [line1, line2, a.senderCountry].filter(Boolean).join(", ") || null;
}

/** Инструкции доставки (native Local Delivery) — из GraphQL. Обрезаем; пусто → "". */
export function normalizeDeliveryInstructions(instructions: string | null | undefined): string {
  return typeof instructions === "string" ? instructions.trim() : "";
}

type FulfillmentOrderEdge = {
  node: { deliveryMethod?: { additionalInformation?: { instructions?: string | null } | null } | null };
};

/**
 * Первая непустая строка инструкций доставки из Order.fulfillmentOrders (GraphQL). Именно это
 * поле показывает Shopify admin в «Additional details → Delivery instructions» для Local Delivery.
 */
export function pickDeliveryInstructionsFromFulfillmentOrders(edges: FulfillmentOrderEdge[] | null | undefined): string {
  for (const e of edges ?? []) {
    const instr = normalizeDeliveryInstructions(e.node.deliveryMethod?.additionalInformation?.instructions);
    if (instr) return instr;
  }
  return "";
}
