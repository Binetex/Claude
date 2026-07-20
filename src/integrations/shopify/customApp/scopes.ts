/**
 * Обязательные Shopify scopes для Floremart и сравнение с фактически выданными.
 * Аудит текущего кода: read_products (каталог), read_orders (приём заказов),
 * write_orders (обратный push адреса/открытки, pushUpdate.ts). read_customers НЕ нужен —
 * данные покупателя приходят вместе с заказом.
 *
 * read_merchant_managed_fulfillment_orders (+ read_assigned_fulfillment_orders) нужны для
 * инструкций доставки native Local Delivery (Order.fulfillmentOrders → deliveryMethod.
 * additionalInformation.instructions — см. deliveryInstructions.ts). Пока магазин их не выдал,
 * инструкции доставки приходят пустыми (ACCESS_DENIED), приём заказа при этом не ломается.
 */
export const REQUIRED_SHOPIFY_SCOPES = [
  "read_products",
  "read_orders",
  "write_orders",
  "read_merchant_managed_fulfillment_orders",
  "read_assigned_fulfillment_orders",
] as const;

export type ScopeDiff = {
  granted: string[];
  missing: string[];
  hasAll: boolean;
};

/** Сравнивает фактически выданные scopes с обязательными. */
export function diffScopes(
  granted: string[],
  required: readonly string[] = REQUIRED_SHOPIFY_SCOPES
): ScopeDiff {
  const set = new Set(granted.map((s) => s.trim()).filter(Boolean));
  const missing = required.filter((r) => !set.has(r));
  return { granted: [...set], missing, hasAll: missing.length === 0 };
}

/** Строка scopes для кнопки «Copy scopes» при создании custom app. */
export function requiredScopesText(): string {
  return REQUIRED_SHOPIFY_SCOPES.join(",");
}
