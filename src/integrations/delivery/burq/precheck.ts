import "server-only";
/**
 * Предварительная проверка «есть ли курьеры на этот маршрут» — ОТДЕЛЬНАЯ отложенная задача.
 *
 * Раньше проверка шла прицепом к созданию черновика, то есть в 04:00 локального дня доставки.
 * Узнать, что маршрут никто не берётся везти, за несколько часов до доставки — поздно: заказ
 * уже собран, и остаётся только везти самим. Теперь проверка запускается, КАК ТОЛЬКО у заказа
 * появляются флорист и точка забора, — обычно в день оформления.
 *
 * Раньше запустить её нельзя: зонд строит маршрут «точка забора → адрес получателя», а точка
 * забора берётся у назначенного флориста. Без флориста маршрута нет, и спрашивать не о чем —
 * поэтому задача просто ждёт назначения и ставится заново при каждом изменении входных данных.
 */
import type { BurqClient } from "./client";
import { buildBurqDraftRequest, DEFAULT_BURQ_DIMENSIONS } from "./request";
import { checkCourierAvailability } from "./courierCheck";
import type { DraftCreatePort } from "./draftHandler";

export const BURQ_COURIER_CHECK_EVENT = "burq.courier.check.requested";

export type BurqCourierCheckPayload = {
  orderId: string;
  /**
   * Версия входных данных. Сменили флориста или адрес — версия другая, значит это НОВАЯ
   * проверка, а не дубль старой: ключ дедупликации её пропустит.
   */
  checkVersion: number;
};

/** Внешний ref зонда: по нему видно, что это проверка, а не боевой заказ. */
export function precheckExternalRef(orderId: string, checkVersion: number): string {
  return `precheck-${orderId}-v${checkVersion}`;
}

export function courierCheckIdempotencyKey(orderId: string, checkVersion: number): string {
  return `burq:courier:check:${orderId}:v${checkVersion}`;
}

export type CourierPrecheckPort = Pick<DraftCreatePort, "loadContext"> & {
  /** Результат проверки — на ЗАКАЗ (черновика ещё нет). Тревога при нуле поднимается там же. */
  recordOrderCourierAvailability(input: {
    orderId: string;
    count: number;
    hasUber: boolean;
    providers: string[];
  }): Promise<void>;
};

export type CourierPrecheckDeps = {
  client: BurqClient;
  port: CourierPrecheckPort;
  log?: (event: string, extra?: Record<string, unknown>) => void;
};

export type CourierPrecheckResult =
  | { outcome: "checked"; count: number }
  | { outcome: "skipped"; reason: "order_missing" | "no_florist" | "no_pickup" | "order_terminal" | "check_failed" };

const TERMINAL = new Set(["DELIVERED", "CANCELLED", "REFUNDED", "PROBLEM"]);

/**
 * Одна проверка. Ничего не ломает: любой отказ оставляет «не проверяли» и молчит — тревога
 * поднимается только по достоверному пустому ответу.
 */
export async function handleCourierPrecheck(
  deps: CourierPrecheckDeps,
  payload: BurqCourierCheckPayload
): Promise<CourierPrecheckResult> {
  const log = deps.log ?? (() => {});
  const ctx = await deps.port.loadContext(payload.orderId);
  if (!ctx) return { outcome: "skipped", reason: "order_missing" };
  if (TERMINAL.has(ctx.order.orderStatus)) return { outcome: "skipped", reason: "order_terminal" };
  if (!ctx.floristId) return { outcome: "skipped", reason: "no_florist" };
  if (!ctx.pickup) return { outcome: "skipped", reason: "no_pickup" };

  const req = buildBurqDraftRequest(
    precheckExternalRef(ctx.order.id, payload.checkVersion),
    ctx.order.dropoff,
    ctx.pickup,
    ctx.dimensions ?? DEFAULT_BURQ_DIMENSIONS
  );

  const check = await checkCourierAvailability(deps.client, req, precheckExternalRef(ctx.order.id, payload.checkVersion));
  if (!check.checked) {
    log("burq.couriers.precheck_skipped", { orderId: ctx.order.id, reason: check.reason });
    return { outcome: "skipped", reason: "check_failed" };
  }

  await deps.port.recordOrderCourierAvailability({
    orderId: ctx.order.id,
    count: check.availability.count,
    hasUber: check.availability.hasUber,
    providers: check.availability.providers,
  });
  log("burq.couriers.prechecked", { orderId: ctx.order.id, count: check.availability.count, hasUber: check.availability.hasUber });
  return { outcome: "checked", count: check.availability.count };
}
