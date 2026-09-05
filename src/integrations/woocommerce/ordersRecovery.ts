import "server-only";
/**
 * Догоняющая синхронизация заказов WooCommerce — САМОСТРАХОВКА, а не основной механизм.
 * Основной путь остаётся прежним: вебхук `order.created` → outbox → ingest.
 *
 * Зачем: вебхуки WooCommerce уходят не мгновенно, а через собственный планировщик магазина
 * (Action Scheduler поверх WP-Cron). На theflow.la WP-Cron отключён (`wp_cron: false` в
 * system_status), поэтому доставка ждёт внешнего запуска: 03.09.2026 заказ 20654 создан в
 * 17:43, а вебхук о нём пришёл в 18:18 — через 34 минуты. Всё это время заказа не было в
 * дашборде, и владелец видел «заказ пропал». Наша сторона в этом не участвует: все запросы
 * Woo приняты с кодом 200, приёмник исправен.
 *
 * Что делает: раз в интервал тянет свежие заказы каждого подключённого Woo-магазина тем же
 * `syncWooOrders`, что стоит за кнопкой «Синхронизировать заказы». Приём идемпотентен (upsert
 * по externalId), watermark двигается только после успешного прохода, поэтому повторный заход
 * по тому же окну безопасен, а пришедший позже вебхук просто обновит уже созданный заказ.
 * Триггеры жизненного цикла (ORDER_PAID и прочие) проход публикует САМ, как живой вебхук: иначе
 * переход «не оплачен → оплачен» записывался бы молча, и опоздавший вебхук его уже не видел.
 *
 * Границы: НИЧЕГО не чинит и не досоздаёт сам — только повторяет штатный приём. Ошибка одного
 * магазина не мешает остальным: каждый обрабатывается отдельно, сбой логируется и учитывается
 * в отчёте прохода.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { syncWooOrders } from "./orderSync";

export type WooOrdersRecoveryResult = { sites: number; failed: number };

export async function recoverWooOrders(prisma: PrismaClient): Promise<WooOrdersRecoveryResult> {
  const connections = await prisma.wooCommerceConnection.findMany({
    where: { connStatus: { not: "DISCONNECTED" }, site: { platform: "WOOCOMMERCE" } },
    select: { siteId: true },
  });

  let failed = 0;
  for (const { siteId } of connections) {
    try {
      // Обычный синк по watermark: без fullHistory, окно — с прошлой удачной синхронизации.
      await syncWooOrders(siteId);
    } catch (err) {
      failed++;
      console.error(
        `[woo] догоняющая синхронизация сайта ${siteId} не удалась:`,
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  return { sites: connections.length, failed };
}
