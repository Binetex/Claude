/**
 * Чистое построение payload Burq Create Order V2 из заказа и pickup-локации флориста.
 * Форма выверена по ФАКТИЧЕСКОМУ поведению sandbox (2026-07-19):
 *  - items[]/pickup/dropoff обязательны; pickup/dropoff плоские;
 *  - `address_details` НЕ отправляем: если он есть, Burq требует latitude/longitude (которых у
 *    нас нет) → шлём ТОЛЬКО строку `address`, Burq геокодирует сам;
 *  - order-level dimensions (length/width/height/weight + units) ОБЯЗАТЕЛЬНЫ (иначе 400
 *    `dimensions_required`); значения берём из глобальных настроек Burq (настраиваемые).
 * Никакого fallback: pickup — только из локации флориста.
 */
import type { BurqCreateOrderRequest, BurqItem } from "./types";

export type DraftOrderInput = {
  recipientName: string;
  recipientPhone: string; // E.164 (нормализуется вызывающим)
  addressLine: string;
  apartment?: string | null;
  city: string;
  recipientState?: string | null;
  zip: string;
  dropoffAtIso?: string | null;
  dropoffInstructions?: string | null;
  /** Позиции заказа (Burq требует >=1). Если пусто — подставляется одна обобщённая. */
  items?: BurqItem[];
  /** Стоимость заказа в центах (опционально). */
  orderValueCents?: number;
};

export type PickupInput = {
  locationName: string;
  contactName: string;
  contactPhone: string; // E.164
  addressLine: string;
  apartmentOrSuite?: string | null;
  city: string;
  state: string; // 2-буквенный
  zip: string;
  courierInstructions?: string | null;
};

/** Глобальные размеры посылки (order-level). Настраиваются в Burq Settings. */
export type BurqDimensions = {
  length: number;
  width: number;
  height: number;
  weight: number;
  dimensionUnit: string; // "in" | "cm"
  weightUnit: string; // "lb" | "kg" | "g"
};

/**
 * Фиксированная ценность содержимого заказа для Burq (order_value). ВСЕГДА $500 = 50000 центов
 * (Burq order_value — integer в центах, подтверждено на V2-контракте/реальном заказе). НЕ берётся
 * из стоимости заказа Floremart. Это НЕ стоимость доставки.
 */
export const BURQ_ORDER_VALUE_CENTS = 50000;

/** Значения по умолчанию (типовой букет), если в настройках не заданы. */
export const DEFAULT_BURQ_DIMENSIONS: BurqDimensions = {
  length: 12,
  width: 8,
  height: 8,
  weight: 3,
  dimensionUnit: "in",
  weightUnit: "lb",
};

/** Полная строка адреса без unit: "line, city, ST zip". */
function fullAddress(line: string, city: string, state: string | null | undefined, zip: string): string {
  const tail = [city, [state?.trim(), zip].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  return [line, tail].filter(Boolean).join(", ");
}

const DEFAULT_ITEM: BurqItem = { name: "Floral delivery", quantity: 1 };

/**
 * Строит тело POST /v2/orders. `externalOrderRef` — стабильная привязка (уходит в external_order_ref,
 * по ней флорист ищет заказ в кабинете Burq). `dimensions` — глобальные order-level размеры.
 * Заказ создаётся неинициированным (курьер не вызывается); инициирование — вручную в Burq Dashboard.
 */
export function buildBurqDraftRequest(
  externalOrderRef: string,
  order: DraftOrderInput,
  pickup: PickupInput,
  dimensions: BurqDimensions = DEFAULT_BURQ_DIMENSIONS
): BurqCreateOrderRequest {
  const items = order.items && order.items.length > 0 ? order.items : [DEFAULT_ITEM];
  return {
    items,
    external_order_ref: externalOrderRef,
    order_value: BURQ_ORDER_VALUE_CENTS, // всегда 50000 (=$500 в центах), не из заказа Floremart
    // order-level dimensions — обязательны.
    length: dimensions.length,
    width: dimensions.width,
    height: dimensions.height,
    weight: dimensions.weight,
    dimension_unit: dimensions.dimensionUnit,
    weight_unit: dimensions.weightUnit,
    pickup: {
      address: fullAddress(pickup.addressLine, pickup.city, pickup.state, pickup.zip),
      ...(pickup.apartmentOrSuite?.trim() ? { unit: pickup.apartmentOrSuite.trim() } : {}),
      phone_number: pickup.contactPhone,
      name: pickup.contactName,
      ...(pickup.courierInstructions?.trim() ? { notes: pickup.courierInstructions.trim() } : {}),
    },
    dropoff: {
      address: fullAddress(order.addressLine, order.city, order.recipientState, order.zip),
      ...(order.apartment?.trim() ? { unit: order.apartment.trim() } : {}),
      phone_number: order.recipientPhone,
      name: order.recipientName,
      ...(order.dropoffInstructions?.trim() ? { notes: order.dropoffInstructions.trim() } : {}),
      ...(order.dropoffAtIso ? { at: order.dropoffAtIso } : {}),
    },
  };
}
