import "server-only";
/**
 * Запись статуса заказа обратно в WooCommerce: подтверждённая Airwallex оплата → `processing`.
 *
 * ЗАЧЕМ. Плагин Airwallex держит заказ в собственном статусе `airwallex-pending`, пока платёж
 * не разрешится. Для BNPL (Klarna/Afterpay) это состояние может жить долго, и всё это время
 * заказ у нас лежит как «ожидает оплаты»: флорист не назначен, черновик Burq не создан.
 * Мониторинг Airwallex при этом уже знает правду — он опрашивает API и видит `SUCCEEDED`.
 * Здесь мы это знание применяем: ставим в магазине `processing`.
 *
 * ПОЧЕМУ ЭТО ЕДИНСТВЕННОЕ, ЧТО МЫ ДЕЛАЕМ. Статус в Woo — не побочный эффект, а МЕХАНИЗМ.
 * На нашу запись Woo отдаёт вебхук `order.updated`, обычный приём (`ingestWooOrder`) видит
 * `processing` и дальше всё едет существующим путём: PAID → CONFIRMED → назначение флориста →
 * черновик Burq → триггеры SMS/Email. Второй копии бизнес-логики перехода не заводим —
 * именно она в прошлом расходилась с оригиналом. Если вебхук потеряется, заказ подберёт
 * обычная синхронизация: схема самовосстанавливается.
 *
 * ГРАНИЦА ДОВЕРИЯ. Переводим ТОЛЬКО по `PAID` (сырой `SUCCEEDED`). `AUTHORIZED_NOT_CAPTURED`
 * оплатой не считается: деньги захолдированы, но на счёт магазина не пришли. Проверено по
 * проду — за всю историю мониторинга это состояние не встречалось ни разу.
 */
import { wooRequest } from "./client";
import type { WooCredentials } from "./credentials";

/** Статус, который проставляем в магазине: «оплачен, в работе». */
export const WOO_PAID_STATUS = "processing";

/**
 * Статусы Woo, поверх которых нам МОЖНО написать `processing`.
 *
 * Список закрытый и намеренно короткий: перезаписываем только состояния ожидания оплаты.
 * `airwallex-pending` — собственный статус плагина, ради него всё и делается; стандартные
 * `pending`/`on-hold` — на случай другой конфигурации магазина.
 *
 * Чего здесь СОЗНАТЕЛЬНО нет:
 *  - `processing`/`completed` — уже оплачен, писать нечего (и не будим лишний вебхук);
 *  - `cancelled`/`refunded` — терминальные решения магазина, перебивать их мы не вправе;
 *  - `failed` — если Airwallex говорит «оплачено», а Woo «отказ», это расхождение для
 *    человека, а не повод тихо переписать чужой отказ. Монитор такое уже помечает
 *    как suspectMismatch и уведомляет владельца.
 */
const PUSHABLE = new Set(["pending", "on-hold", "airwallex-pending"]);

export function isPushableWooStatus(wooStatus: string | null | undefined): boolean {
  return PUSHABLE.has((wooStatus ?? "").trim().toLowerCase());
}

/**
 * Ставит заказу в WooCommerce статус `processing`. Бросает WooApiError — решение о повторе
 * принимает вызывающий (в outbox-обработчике это retry с backoff).
 */
export async function pushWooOrderPaid(creds: WooCredentials, externalId: string): Promise<void> {
  await wooRequest(creds, `/orders/${encodeURIComponent(externalId)}`, {
    method: "PUT",
    body: { status: WOO_PAID_STATUS },
  });
}
