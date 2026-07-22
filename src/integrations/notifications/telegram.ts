import "server-only";
import { enqueue } from "@/lib/jobs";
import { featureFlags } from "@/lib/featureFlags";

/**
 * Адаптер Telegram-уведомлений (стаб на этапе 1).
 * Реальная отправка появится позже за этим же интерфейсом, под флагом TELEGRAM_ENABLED.
 */
export async function notifyFloristAssigned(
  floristId: string,
  orderId: string
): Promise<void> {
  if (!featureFlags.telegram) return; // интеграция выключена — назначение всё равно проходит
  await enqueue("notify.florist.assigned", { floristId, orderId });
}
