/**
 * Заказ из прошлого, которого у нас ещё не было: живым он не становится (владелец 30.09.2026).
 *
 * Как это случилось: клиент TheFlow, раньше заказывавший гостем, завёл на сайте аккаунт.
 * WooCommerce при регистрации привязывает к аккаунту все его прошлые гостевые заказы с тем же
 * email и пересохраняет их — и на каждое пересохранение шлёт вебхук «заказ обновлён». Заказы 2025
 * года (THEFLOW-15339, THEFLOW-17708), которых в системе не было, пришли как новые оплаченные:
 * назначились Насте, ей ушли карточки «Новый заказ», клиенту — письма «спасибо за заказ».
 *
 * Прошлое — это доставка раньше вчерашнего дня магазина И оформлен больше двух суток назад: оба
 * условия сразу. Свежий заказ с датой доставки в прошлом (ошибка клиента) и заказ, оформленный
 * давно на будущую дату, остаются живыми.
 *
 * Чистая функция: «сейчас» передаётся параметром.
 */
import { todayStrInTz } from "@/lib/tz";

const DAY_MS = 86_400_000;
/** Оформлен давнее этого — заказ не свежий. */
const OLD_ORDER_MS = 2 * DAY_MS;

export function isHistoricalOrder(args: { deliveryDate: Date; createdAt: Date; now: Date; timezone?: string | null }): boolean {
  const today = todayStrInTz(args.timezone ?? null, args.now);
  const yesterday = new Date(Date.parse(`${today}T00:00:00Z`) - DAY_MS).toISOString().slice(0, 10);
  // deliveryDate — UTC-полночь ЛОКАЛЬНОГО дня: день берём UTC-датой, без таймзоны (см. CLAUDE.md).
  const day = args.deliveryDate.toISOString().slice(0, 10);
  return day < yesterday && args.now.getTime() - args.createdAt.getTime() > OLD_ORDER_MS;
}
