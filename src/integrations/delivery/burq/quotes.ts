/**
 * Проверка «есть ли курьеры на этот маршрут». Чистая часть — без сети и без БД.
 *
 * Зачем: флорист открывал «Assign Provider» в кабинете Burq и иногда видел, что провайдеров
 * нет. Узнавать об этом в момент отправки поздно — заказ уже надо везти. Проверка делается
 * сразу после создания черновика, и владельца с флористом дёргаем ТОЛЬКО когда курьеров нет.
 *
 * Контракт подтверждён живым прогоном на проде (04.08.2026), не по документации — она
 * неполная. Реальный ответ `GET /v2/routes/{id}/quotes`:
 *
 *   { "object": "route_quotes", "status": "COMPLETE", "data": [
 *       { "provider": "grubhub", "cost_of_delivery": 2089, "burq_fee": 99, … },
 *       { "provider": "Uber",    "cost_of_delivery": 1849, "burq_fee": 99, … } ] }
 *
 * Суммы в ЦЕНТАХ (как и все деньги у Burq). Имя провайдера приходит в разном регистре
 * («Uber», «grubhub»), поэтому сравнение всегда через нормализацию. `provider_id` в котировке
 * НЕ приходит — только имя, так что Uber узнаём по имени.
 */

/** Котировка одного провайдера. Поля — те, что реально приходят. */
export type RouteQuote = {
  provider?: string | null;
  cost_of_delivery?: number | null;
  burq_fee?: number | null;
  pickup_time?: string | null;
  expires_at?: string | null;
};

export type RouteQuotesResponse = {
  status?: string | null;
  data?: RouteQuote[] | null;
};

export type CourierAvailability = {
  /** Сколько провайдеров готовы везти. 0 — никто. */
  count: number;
  /** Есть ли среди них Uber: у нас на нём завязан захват стоимости доставки. */
  hasUber: boolean;
  /** Имена провайдеров как пришли — для сообщения человеку. */
  providers: string[];
  /** Самая дешёвая доставка в центах (cost_of_delivery + burq_fee), null если котировок нет. */
  cheapestCents: number | null;
};

const norm = (v: string | null | undefined) => (v ?? "").trim().toLowerCase();

/** Итог котировки: полная стоимость = доставка + комиссия Burq. Обе в центах. */
function totalCents(q: RouteQuote): number | null {
  const cost = typeof q.cost_of_delivery === "number" ? q.cost_of_delivery : null;
  if (cost == null) return null;
  const fee = typeof q.burq_fee === "number" ? q.burq_fee : 0;
  return cost + fee;
}

/**
 * Сводка по списку котировок.
 *
 * Пустой список — валидный ответ, а не ошибка: именно так Burq говорит «никто не берётся».
 * Отличать «никто не берётся» от «мы не спросили» обязан вызывающий — по времени проверки.
 */
export function summarizeQuotes(res: RouteQuotesResponse | null | undefined): CourierAvailability {
  const rows = Array.isArray(res?.data) ? res!.data! : [];
  const providers = rows.map((q) => (q.provider ?? "").trim()).filter((p) => p.length > 0);
  const totals = rows.map(totalCents).filter((c): c is number => c != null);
  return {
    count: rows.length,
    hasUber: providers.some((p) => norm(p) === "uber"),
    providers,
    cheapestCents: totals.length ? Math.min(...totals) : null,
  };
}

/** Опрос завершён — можно читать data. */
export function isQuotesComplete(res: RouteQuotesResponse | null | undefined): boolean {
  return norm(res?.status) === "complete";
}
