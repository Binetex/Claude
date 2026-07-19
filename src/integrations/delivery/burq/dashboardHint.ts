/**
 * Чистая модель отображения панели доставки Burq для флориста. Никаких серверных зависимостей —
 * используется и client-компонентом, и тестами.
 *
 * UX (подтверждён с заказчиком): флорист открывает Burq Dashboard и находит заказ по ИМЕНИ
 * ПОЛУЧАТЕЛЯ (dropoff.name = Order.recipientName). External Order ID НЕ является частью
 * ежедневной работы флориста (остаётся внутри системы: идемпотентность/связь попыток/диагностика/API).
 *
 * НЕ конструируем per-order URL (Burq его не подтверждает) — ведём на страницу списка заказов.
 */
export const BURQ_DASHBOARD_ORDERS_URL = "https://app.burqup.com/v1/orders";
export const BURQ_FIND_BY_NAME_TEXT = "Найдите заказ в Burq по имени получателя.";

export type BurqEnv = "SANDBOX" | "PRODUCTION";

/** Подсказка про режим Dashboard перед поиском (Test для sandbox, Live для production). */
export function burqDashboardModeHint(environment: BurqEnv): string {
  return environment === "PRODUCTION" ? "Перед поиском включите Live mode в Burq." : "Перед поиском включите Test mode в Burq.";
}

export type DeliveryPanelInput = {
  delivery: { status: string; externalDeliveryId: string | null } | null;
  recipientName: string;
  environment: BurqEnv;
};

/**
 * Модель панели. Намеренно НЕ содержит external_order_ref/checkout_url как пользовательские
 * действия — только имя получателя, ссылку на Dashboard, подсказки и (мелким текстом) Burq Order ID
 * для диагностики. Отсутствие checkout_url НЕ влияет на модель (её тут нет).
 */
export function buildDeliveryPanelView(input: DeliveryPanelInput): {
  hasDelivery: boolean;
  recipientName: string;
  dashboardUrl: string;
  findByNameText: string;
  modeHint: string;
  /** Burq Order ID — только служебный/диагностический мелкий текст, не для поиска. */
  orderIdDiagnostic: string | null;
} {
  return {
    hasDelivery: !!input.delivery,
    recipientName: input.recipientName,
    dashboardUrl: BURQ_DASHBOARD_ORDERS_URL,
    findByNameText: BURQ_FIND_BY_NAME_TEXT,
    modeHint: burqDashboardModeHint(input.environment),
    orderIdDiagnostic: input.delivery?.externalDeliveryId ?? null,
  };
}
