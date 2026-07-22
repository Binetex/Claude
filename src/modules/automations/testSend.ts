import "server-only";
/**
 * Ядро тестовой отправки. НЕ трогает БД (нет импорта prisma): не создаёт AutomationJob и не
 * пишет OrderCommunication — только рендер по примерным переменным (+реальные поля магазина) и
 * прямой вызов QUO-клиента. Так гарантируется, что «Отправить тест» не создаёт production-задачу.
 */
import type { QuoClient } from "@/integrations/quo/client";
import { buildOrderVariables, SMS_VARIABLES } from "./variables";
import { renderTemplate } from "./template";

export type TestSendSite = { name: string | null; quoPhoneNumber: string | null; reviewUrl: string | null };

/** Рендерит тестовое сообщение: примерные значения переменных + реальные store_name/phone/review_url. */
export function buildTestMessage(template: string, site: TestSendSite): string {
  const ex = Object.fromEntries(SMS_VARIABLES.map((v) => [v.key, v.example]));
  const vars = buildOrderVariables({
    orderNumber: ex.order_number,
    senderName: ex.sender_name,
    recipientName: ex.recipient_name,
    senderPhone: ex.sender_phone,
    recipientPhone: ex.recipient_phone,
    addressLine: "1 Main St",
    apartment: "4",
    city: "Portland",
    deliveryDate: new Date(),
    deliveryWindow: ex.delivery_time,
    trackingUrl: ex.tracking_url,
    cardMessage: ex.card_message,
    deliveryInstructions: ex.delivery_instructions,
    customerTotal: 115,
    storeName: site.name,
    storePhone: site.quoPhoneNumber,
    reviewUrl: site.reviewUrl,
    timezone: null,
  });
  const { text } = renderTemplate(template, vars);
  return `[ТЕСТ] ${text || "Test message"}`;
}

export async function sendTestSmsViaClient(client: QuoClient, args: { fromId: string; to: string; body: string }): Promise<void> {
  await client.sendMessage({ content: args.body, from: args.fromId, to: [args.to] });
}
