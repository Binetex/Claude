import "server-only";
/**
 * «Есть ли курьеры на этот маршрут» — запускается сразу после создания Burq-черновика.
 *
 * ЗАЧЕМ ОТДЕЛЬНЫЙ ЗАКАЗ-ЗОНД. Котировки в v2 живут на МАРШРУТЕ, а маршрут строится из
 * существующих заказов. Привязать к маршруту боевой черновик — значит потрогать заказ,
 * который флорист вот-вот будет отправлять руками в кабинете Burq; если удаление маршрута
 * не пройдёт, черновик останется в чужой сущности. Поэтому котируется ОДНОРАЗОВЫЙ заказ с
 * теми же адресами: ответ тот же (вопрос-то про маршрут), а боевой черновик не трогается
 * вообще. Зонд и маршрут удаляются в finally.
 *
 * Всё best-effort: любая ошибка оставляет couriersAvailable = NULL («не проверяли») и НЕ
 * ломает создание черновика. Тревога поднимается только по достоверному пустому ответу.
 *
 * Контракт снят живым прогоном на проде 04.08.2026 (см. quotes.ts).
 */
import type { BurqClient } from "./client";
import type { BurqCreateOrderRequest } from "./types";
import { summarizeQuotes, isQuotesComplete, type CourierAvailability } from "./quotes";

/** Сколько ждём расчёта. На проде COMPLETE пришёл с первой попытки (~3 с). */
const POLL_ATTEMPTS = 6;
const POLL_DELAY_MS = 2500;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type CourierCheckResult =
  | { checked: true; availability: CourierAvailability }
  | { checked: false; reason: string };

/**
 * Спрашивает Burq, кто готов везти маршрут черновика.
 *
 * `draftRequest` — ровно то тело, которым создавался черновик: те же адреса, те же размеры.
 * Меняется только `external_order_ref`, чтобы зонд нельзя было спутать с боевым заказом ни
 * в кабинете Burq, ни в вебхуках.
 */
export async function checkCourierAvailability(
  client: BurqClient,
  draftRequest: BurqCreateOrderRequest,
  probeRef: string
): Promise<CourierCheckResult> {
  let probeOrderId: string | null = null;
  let routeId: string | null = null;
  try {
    const probe = await client.createDraft({ ...draftRequest, external_order_ref: probeRef }, probeRef);
    probeOrderId = probe.id;

    const route = await client.createRoute([probe.id]);
    routeId = route.id;

    await client.requestRouteQuotes(route.id);

    // Спрашиваем СРАЗУ, ждём только между попытками: на проде COMPLETE приходит за секунды,
    // а лишняя пауза перед первым запросом замедляла бы и тесты, и воркер на ровном месте.
    for (let i = 0; i < POLL_ATTEMPTS; i++) {
      if (i > 0) await sleep(POLL_DELAY_MS);
      const res = await client.listRouteQuotes(route.id);
      if (isQuotesComplete(res)) return { checked: true, availability: summarizeQuotes(res) };
    }
    // Не досчиталось за отведённое время — это НЕ «курьеров нет». Молчим.
    return { checked: false, reason: "quotes_timeout" };
  } catch (err) {
    return { checked: false, reason: err instanceof Error ? err.name : "error" };
  } finally {
    // Прибираем за собой в любом случае: маршрут раньше заказа (заказ в нём состоит).
    // try/catch, а не .catch() на результате: уборка не должна зависеть от того, вернул ли
    // клиент промис, и не должна маскировать исходную ошибку своей собственной.
    if (routeId) {
      try {
        await client.deleteRoute(routeId);
      } catch {
        /* маршрут остался в Burq — не критично, заказов он не держит */
      }
    }
    if (probeOrderId) {
      try {
        await client.deleteOrder(probeOrderId);
      } catch {
        /* зонд остался неинициированным: курьера не вызывает и денег не стоит */
      }
    }
  }
}

/** Ссылка зонда: заведомо отличается от боевой `orderId:aN`. */
export function probeExternalRef(orderId: string, attemptNumber: number): string {
  return `probe:${orderId}:a${attemptNumber}`;
}
