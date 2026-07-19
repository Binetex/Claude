/**
 * Типы запроса/ответа Burq Create Order V2. Форма ПОДТВЕРЖДЕНА по официальной документации
 * (burq.readme.io/reference/createorderv2, getorderv2, deleteorder):
 *  - POST /v2/orders, auth `x-api-key`, база https://api.burqup.com/v2 (sandbox = тот же host +
 *    ТЕСТОВЫЙ ключ → в ответе test_mode=true; отдельного sandbox-хоста нет);
 *  - обязательны items[], pickup, dropoff; pickup/dropoff — ПЛОСКИЕ (без location/contact);
 *  - начальный статус НЕинициированного заказа — `request` (курьер не вызывается, деньги не
 *    списываются, заказ можно DELETE); отдельного флага initiate/draft НЕТ;
 *  - статус доставки лежит в `latest_delivery.status` (GET требует ?expand=latest_delivery).
 *
 * ОТКРЫТО (проверяется sandbox smoke-тестом): поддержка `x-idempotency-key` на POST /orders и
 * дедуп повторного POST (в доках не задокументировано).
 */

/**
 * Плоская pickup/dropoff-точка Burq. `address` — полная строка адреса БЕЗ unit.
 * `address_details` НЕ используем: sandbox требует latitude/longitude при его наличии — шлём
 * только строку address (Burq геокодирует).
 */
export type BurqStop = {
  address: string;
  unit?: string;
  phone_number: string; // E.164
  name: string;
  contact_email?: string;
  notes?: string; // инструкции курьеру
  at?: string | null; // ISO8601 — желаемое время pickup/dropoff
};

export type BurqItem = {
  name: string;
  quantity: number;
  unit_price?: number; // в центах
  description?: string;
};

/**
 * Тело POST /v2/orders (Create Order V2). items/pickup/dropoff обязательны; order-level
 * dimensions обязательны (sandbox: `dimensions_required`).
 */
export type BurqCreateOrderRequest = {
  items: BurqItem[];
  pickup: BurqStop;
  dropoff: BurqStop;
  external_order_ref?: string;
  order_value?: number; // в центах
  length: number;
  width: number;
  height: number;
  weight: number;
  dimension_unit: string;
  weight_unit: string;
};

/** Сырой ответ Burq (нужные поля). Статус и стоимость — в latest_delivery. Суммы — в ЦЕНТАХ. */
export type BurqRawOrderResponse = {
  id: string;
  external_order_ref?: string | null;
  checkout_url?: string | null;
  order_token?: string | null;
  test_mode?: boolean;
  latest_delivery?: {
    status?: string | null;
    tracking_url?: string | null;
    courier?: { name?: string | null; phone_number_for_customer?: string | null } | null;
    total_amount_due?: number | null; // полная сумма к списанию (без чаевых), центы
    fee?: number | null; // "delivery cost" для отображения (quote workflow), центы
    currency?: string | null; // ISO4217
    // provider: строка ("Uber", в GET) ИЛИ объект { id: "dsp_...", name: "Uber" } (в webhook).
    provider?: string | { id?: string | null; name?: string | null } | null;
    provider_id?: string | null; // покоштучный id доставки (del_...), НЕ стабильный провайдер
    quote_id?: string | null;
  } | null;
};

/** Нормализованный заказ Burq — то, что возвращает клиент наружу (без нестинга Burq). Суммы — центы. */
export type BurqOrder = {
  id: string;
  status: string; // сырой Burq-статус (начальный — "request")
  checkoutUrl: string | null;
  orderToken: string | null;
  trackingUrl: string | null;
  courierName: string | null;
  courierPhone: string | null;
  testMode: boolean;
  externalOrderRef: string | null;
  // Стоимость/провайдер доставки (появляются после dispatch). Суммы — в ЦЕНТАХ.
  totalAmountDueCents: number | null;
  feeCents: number | null;
  currency: string | null;
  provider: string | null;
  providerId: string | null;
  quoteId: string | null;
};

/**
 * Нормализованное Burq-webhook-событие (после verify+parse). Без полного payload/PII.
 * data вебхука — Delivery resource: id=`d_...` (delivery id), external_order_ref = НАШ ref
 * (по нему матчим Delivery), + стоимость/провайдер прямо в payload.
 */
export type BurqWebhookEvent = {
  deliveryExternalId: string; // data.id (d_...)
  externalOrderRef: string | null; // data.external_order_ref — ключ матчинга нашей Delivery
  rawStatus: string;
  providerEventId: string | null;
  occurredAt: Date | null;
  courierName?: string | null;
  courierPhone?: string | null;
  trackingUrl?: string | null;
  // Стоимость/провайдер прямо из webhook data (Delivery resource). Суммы — в ЦЕНТАХ.
  provider?: string | null;
  providerId?: string | null;
  totalAmountDueCents?: number | null;
  feeCents?: number | null;
  currency?: string | null;
  quoteId?: string | null;
};
