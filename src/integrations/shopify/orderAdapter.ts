import "server-only";
import type { OrderAdapter } from "@/integrations/types";
import type {
  NormalizedOrder,
  NormalizedOrderItem,
  NormalizedAddress,
  NormalizedExternalStatus,
} from "@/integrations/normalized";
import type { PaymentStatus } from "@/generated/prisma/enums";
import type { ShopifyOrder } from "./ingestOrder";

/**
 * Shopify как реализация общего `OrderAdapter`: нормализует webhook-payload в `NormalizedOrder`.
 *
 * ВНИМАНИЕ: рабочий приём заказов идёт через `ingestOrder.ts` (create-then-catch, идемпотентно).
 * Этот нормализатор — параллельный, канонический путь на будущее (см. REFACTOR_BACKLOG A);
 * он НЕ подключён в live-ingest ночью, чтобы не менять поведение рабочего потока без полного
 * regression-набора. Используется реестром и покрыт тестами маппинга статусов/полей.
 */

const num = (v: string | number | null | undefined): number => {
  if (v == null) return 0;
  const n = typeof v === "string" ? parseFloat(v) : v;
  return Number.isFinite(n) ? n : 0;
};

function mapPayment(financialStatus: string | null | undefined): PaymentStatus {
  if (financialStatus === "paid") return "PAID";
  if (financialStatus === "refunded") return "REFUNDED";
  if (financialStatus === "partially_refunded") return "PARTIALLY_REFUNDED";
  return "UNPAID";
}

/** Деривация статуса заказа — согласована с ingestOrder.deriveOrderState. */
function mapStatus(payload: ShopifyOrder): NormalizedExternalStatus {
  const payment = mapPayment(payload.financial_status);
  if (payload.cancelled_at) return { payment, order: "CANCELLED", delivery: null };
  if (payload.fulfillment_status === "fulfilled")
    return { payment, order: "DELIVERED", delivery: "DELIVERED" };
  return { payment, order: payment === "PAID" ? "CONFIRMED" : "AWAITING_PAYMENT", delivery: null };
}

type ShopifyAddress = NonNullable<ShopifyOrder["shipping_address"]>;
function fullName(a: ShopifyAddress | null | undefined): string {
  if (!a) return "";
  if (a.name) return a.name;
  return [a.first_name, a.last_name].filter(Boolean).join(" ").trim();
}

function toAddress(a: ShopifyAddress | null | undefined): NormalizedAddress | null {
  if (!a || !a.address1) return null;
  return {
    name: fullName(a),
    phone: a.phone?.trim() || null,
    line1: a.address1 ?? "",
    line2: a.address2?.trim() || null,
    city: a.city ?? "",
    zip: a.zip ?? "",
    country: null,
  };
}

function noteAttr(payload: ShopifyOrder, pattern: RegExp): string | null {
  return payload.note_attributes?.find((a) => a.name && pattern.test(a.name))?.value ?? null;
}

export function parseShopifyOrder(payload: ShopifyOrder): NormalizedOrder {
  const items: NormalizedOrderItem[] = (payload.line_items ?? []).map((li) => {
    const variantName = li.variant_title?.trim() || null;
    return {
      externalId: null,
      productExternalId: li.product_id != null ? String(li.product_id) : null,
      variantExternalId: li.variant_id != null ? String(li.variant_id) : null,
      name: li.title,
      variantName: variantName && variantName !== "Default Title" ? variantName : null,
      sku: li.sku?.trim() || null,
      quantity: li.quantity,
      unitPrice: num(li.price),
      image: null,
    };
  });

  return {
    platform: "SHOPIFY",
    externalId: String(payload.id),
    externalNumber: payload.order_number != null ? String(payload.order_number) : null,
    createdAt: payload.created_at ?? new Date().toISOString(),
    deliveryDate: noteAttr(payload, /delivery.*date/i),
    deliveryWindow: noteAttr(payload, /delivery.*(time|window)/i),
    sender: {
      externalId: null,
      name:
        fullName(payload.billing_address) ||
        [payload.customer?.first_name, payload.customer?.last_name].filter(Boolean).join(" ") ||
        "—",
      phone: payload.billing_address?.phone || payload.customer?.phone || null,
      email: payload.email ?? payload.contact_email ?? null,
    },
    recipient: {
      externalId: null,
      name: fullName(payload.shipping_address) || "—",
      phone: payload.shipping_address?.phone || null,
      email: null,
    },
    shippingAddress: toAddress(payload.shipping_address),
    cardMessage: payload.note ?? "",
    customerNote: "",
    items,
    money: {
      itemsTotal: num(payload.subtotal_price),
      tax: num(payload.total_tax),
      tip: num(payload.total_tip_received),
      discount: num(payload.total_discounts),
      deliveryCost: num(payload.total_shipping_price_set?.shop_money?.amount),
      total: num(payload.total_price),
    },
    status: mapStatus(payload),
    raw: payload,
  };
}

export const shopifyOrderAdapter: OrderAdapter = {
  platform: "SHOPIFY",
  parseWebhook(rawBody: unknown): NormalizedOrder {
    const payload = (typeof rawBody === "string" ? JSON.parse(rawBody) : rawBody) as ShopifyOrder;
    return parseShopifyOrder(payload);
  },
  async pushUpdate(externalId, changes) {
    // Реальный пуш адреса/открытки в Shopify требует домена+токена магазина и уже
    // реализован в рабочем потоке как `syncOrderToShopify(orderId)` (pushUpdate.ts),
    // вызываемом из server actions. Здесь — skeleton единого контракта: подключение
    // к реестру произойдёт вместе с переносом ingest на нормализованный путь (backlog A).
    // Логируем ТОЛЬКО ключи полей (не значения) — значения могут содержать PII (адрес/открытка).
    console.log(`[shopify] OrderAdapter.pushUpdate skeleton ${externalId}, поля: ${Object.keys(changes).join(", ")}`);
  },
};
