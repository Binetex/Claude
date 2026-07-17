import "server-only";
import type { OrderAdapter } from "@/integrations/types";
import type {
  NormalizedOrder,
  NormalizedOrderItem,
  NormalizedAddress,
} from "@/integrations/normalized";
import { featureFlags } from "@/lib/featureFlags";
import { mapWooStatus, type WooOrderStatus } from "./statusMap";

/**
 * Skeleton-адаптер заказов WooCommerce. `parseWebhook` — реальный маппинг Woo REST-формы
 * заказа в `NormalizedOrder` (без сети, тестируемо). `pushUpdate` — заглушка под флагом
 * `WOOCOMMERCE_ENABLED` (реальный PUT /wp-json/wc/v3/orders — этап 2).
 *
 * Локальные поля Floremart (florist composition/price, оригиналы открытки) сюда не входят —
 * нормализация несёт только внешние данные; merge с локальными делается выше по потоку.
 */

type WooAddress = {
  first_name?: string;
  last_name?: string;
  phone?: string;
  email?: string;
  address_1?: string;
  address_2?: string;
  city?: string;
  postcode?: string;
  country?: string;
};

type WooLineItem = {
  id?: number | string;
  name?: string;
  product_id?: number | string;
  variation_id?: number | string;
  sku?: string;
  quantity?: number;
  price?: number | string;
};

export type WooOrder = {
  id: number | string;
  number?: string;
  status?: WooOrderStatus;
  date_created?: string;
  billing?: WooAddress;
  shipping?: WooAddress;
  line_items?: WooLineItem[];
  total?: string | number;
  total_tax?: string | number;
  shipping_total?: string | number;
  discount_total?: string | number;
  customer_note?: string;
  meta_data?: { key?: string; value?: unknown }[];
};

const num = (v: unknown): number => {
  const n = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : 0;
  return Number.isFinite(n) ? n : 0;
};

const fullName = (a: WooAddress | undefined): string =>
  [a?.first_name, a?.last_name].filter(Boolean).join(" ").trim();

function toAddress(a: WooAddress | undefined): NormalizedAddress | null {
  if (!a || !a.address_1) return null;
  return {
    name: fullName(a),
    phone: a.phone?.trim() || null,
    line1: a.address_1 ?? "",
    line2: a.address_2?.trim() || null,
    city: a.city ?? "",
    zip: a.postcode ?? "",
    country: a.country?.trim() || null,
  };
}

function metaValue(order: WooOrder, keyPattern: RegExp): string | null {
  const hit = order.meta_data?.find((m) => m.key && keyPattern.test(m.key));
  return hit && hit.value != null ? String(hit.value) : null;
}

export function parseWooOrder(order: WooOrder): NormalizedOrder {
  const status = mapWooStatus(order.status ?? "pending");
  const items: NormalizedOrderItem[] = (order.line_items ?? []).map((li) => ({
    externalId: li.id != null ? String(li.id) : null,
    productExternalId: li.product_id != null ? String(li.product_id) : null,
    variantExternalId: li.variation_id ? String(li.variation_id) : null,
    name: li.name ?? "—",
    variantName: null,
    sku: li.sku?.trim() || null,
    quantity: li.quantity ?? 1,
    unitPrice: num(li.price),
    image: null,
  }));

  const total = num(order.total);
  const tax = num(order.total_tax);
  const deliveryCost = num(order.shipping_total);
  const discount = num(order.discount_total);
  const itemsTotal = items.reduce((s, i) => s + i.unitPrice * i.quantity, 0);

  return {
    platform: "WOOCOMMERCE",
    externalId: String(order.id),
    externalNumber: order.number ?? null,
    createdAt: order.date_created ?? new Date().toISOString(),
    deliveryDate: metaValue(order, /delivery.*date/i),
    deliveryWindow: metaValue(order, /delivery.*(time|window)/i),
    sender: {
      externalId: null,
      name: fullName(order.billing) || "—",
      phone: order.billing?.phone?.trim() || null,
      email: order.billing?.email?.trim() || null,
    },
    recipient: {
      externalId: null,
      name: fullName(order.shipping) || fullName(order.billing) || "—",
      phone: order.shipping?.phone?.trim() || null,
      email: null,
    },
    shippingAddress: toAddress(order.shipping) ?? toAddress(order.billing),
    cardMessage: order.customer_note ?? "",
    customerNote: "",
    items,
    money: { itemsTotal, tax, tip: 0, discount, deliveryCost, total },
    status,
    raw: order,
  };
}

export const wooCommerceOrderAdapter: OrderAdapter = {
  platform: "WOOCOMMERCE",
  parseWebhook(rawBody: unknown): NormalizedOrder {
    const order = (typeof rawBody === "string" ? JSON.parse(rawBody) : rawBody) as WooOrder;
    return parseWooOrder(order);
  },
  async pushUpdate(externalId, changes) {
    if (!featureFlags.woocommerce) {
      console.log(`[woo] интеграция выключена (WOOCOMMERCE_ENABLED=false), пропуск pushUpdate ${externalId}`);
      return;
    }
    // TODO(этап 2): PUT /wp-json/wc/v3/orders/{externalId} с разрешёнными полями.
    // Логируем ТОЛЬКО ключи полей (не значения) — значения могут содержать PII.
    console.log(`[woo] pushUpdate ${externalId}, поля: ${Object.keys(changes).join(", ")}`);
  },
};
