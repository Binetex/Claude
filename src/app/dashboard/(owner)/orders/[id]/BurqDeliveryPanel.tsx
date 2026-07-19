"use client";
import { useActionState } from "react";
import { Card, CardHeader, CardTitle, CardBody } from "@/components/ui/Card";
import { Button } from "@/components/ui/button";
import { resolveDeliveryAction, createNewDeliveryAttemptAction } from "./deliveryActions";
import { buildDeliveryPanelView, type BurqEnv } from "@/integrations/delivery/burq/dashboardHint";

export type DeliveryPanelData = {
  id: string;
  status: string;
  attemptNumber: number;
  externalDeliveryId: string | null;
  finalCost: number | null;
  currency: string | null;
  providerName: string | null;
  finalCostUpdatedAt: string | null;
} | null;

export type DeliveryAttempt = {
  attemptNumber: number;
  status: string;
  createdAt: string;
  cancelledAt: string | null;
  deliveredAt: string | null;
  finalCost: number | null;
  currency: string | null;
  externalDeliveryId: string | null;
  floristName: string | null;
  cancellationReason: string | null;
};

export type IntentData = { intentStatus: string; lastSkipReason: string | null; scheduledAvailableAt: string | null } | null;

/** Статусы попытки, из которых доступна повторная доставка (и показывается красный блок). */
const RETRYABLE = new Set(["CANCELLED", "FAILED", "PROBLEM", "RETURNED"]);
const TERMINAL_ORDER = new Set(["DELIVERED", "CANCELLED"]);

const STATUS_RU: Record<string, string> = {
  DRAFT_PENDING: "Черновик создаётся",
  DRAFT_CREATED: "Черновик создан",
  SCHEDULED: "Запланирована",
  COURIER_ASSIGNED: "Курьер назначен",
  COURIER_EN_ROUTE_TO_PICKUP: "Курьер едет за заказом",
  AT_PICKUP: "Курьер на точке забора",
  PICKED_UP: "Заказ забран",
  IN_TRANSIT: "В пути",
  DELIVERED: "Доставлено",
  PROBLEM: "Проблема — нужно решение",
  CANCELLED: "Отменена",
  FAILED: "Ошибка доставки",
  RETURNING: "Возврат",
  RETURNED: "Возвращено",
  UNKNOWN: "Неизвестно",
};

const INTENT_RU: Record<string, string> = {
  SCHEDULED: "Запланировано автосоздание черновика",
  WAITING_FOR_FLORIST: "Ожидает флориста / настройки точки забора",
  DRAFT_CREATED: "Черновик создан",
  SKIPPED: "Пропущено",
  FAILED: "Ошибка планирования",
};

const SKIP_RU: Record<string, string> = {
  no_florist: "не назначен флорист",
  pickup_invalid: "не настроена точка забора флориста",
  site_disabled: "автосоздание отключено для магазина",
  order_terminal: "заказ в терминальном статусе",
  draft_exists: "черновик уже существует",
};

/**
 * Панель доставки Burq для флориста. Минимально: статус, ИМЯ ПОЛУЧАТЕЛЯ, кнопка «Открыть Burq
 * Dashboard» (флорист находит заказ по имени), Burq Order ID мелким служебным текстом. External
 * Order ID НЕ показывается как действие; поиск по номеру не требуется; отсутствие checkout_url не
 * ломает карточку. Блок ручного решения проблемы сохранён.
 */
export function BurqDeliveryPanel({
  orderId,
  delivery,
  intent,
  recipientName,
  environment,
  orderStatus,
  attempts,
}: {
  orderId: string;
  delivery: DeliveryPanelData;
  intent: IntentData;
  recipientName: string;
  environment: BurqEnv;
  orderStatus: string;
  attempts: DeliveryAttempt[];
}) {
  const [state, action, pending] = useActionState(resolveDeliveryAction, null);
  const [retryState, retryAction, retryPending] = useActionState(createNewDeliveryAttemptAction, null);
  const isProblem = delivery?.status === "PROBLEM";
  const isCancelledAttempt = !!delivery && RETRYABLE.has(delivery.status);
  const canRetry = isCancelledAttempt && !TERMINAL_ORDER.has(orderStatus);
  const view = buildDeliveryPanelView({
    delivery: delivery ? { status: delivery.status, externalDeliveryId: delivery.externalDeliveryId } : null,
    recipientName,
    environment,
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Доставка (Burq)</CardTitle>
      </CardHeader>
      <CardBody className="space-y-3 text-sm">
        {!delivery && (
          <div className="text-slate-500">
            Черновик доставки ещё не создан.
            {intent && (
              <div className="mt-1 text-xs text-slate-400">
                {INTENT_RU[intent.intentStatus] ?? intent.intentStatus}
                {intent.lastSkipReason && ` · ${SKIP_RU[intent.lastSkipReason] ?? intent.lastSkipReason}`}
              </div>
            )}
          </div>
        )}

        {delivery && (
          <>
            <div className="flex items-center gap-2">
              <span
                className={
                  "inline-flex items-center rounded-md px-2 py-0.5 text-xs font-semibold " +
                  (isProblem || isCancelledAttempt
                    ? "bg-red-100 text-red-700"
                    : delivery.status === "DELIVERED"
                      ? "bg-emerald-100 text-emerald-700"
                      : "bg-slate-100 text-slate-700")
                }
              >
                {STATUS_RU[delivery.status] ?? delivery.status}
              </span>
            </div>

            {/* Красный блок отменённой/провальной попытки + повторная доставка. */}
            {isCancelledAttempt && (
              <div className="rounded-md border border-red-200 bg-red-50 p-3">
                <div className="text-xs font-semibold text-red-700">Доставка Burq отменена</div>
                <p className="mt-1 text-xs text-red-700">Эта попытка доставки завершена. При необходимости создайте новую доставку Burq.</p>
                {canRetry && (
                  <form action={retryAction} className="mt-2">
                    <input type="hidden" name="orderId" value={orderId} />
                    <Button type="submit" size="sm" disabled={retryPending}>
                      {retryPending ? "Создание…" : "Создать новую доставку Burq"}
                    </Button>
                  </form>
                )}
                {retryState?.error && <p className="mt-1 text-xs text-red-600">{retryState.error}</p>}
                {retryState?.ok && <p className="mt-1 text-xs text-emerald-700">{retryState.message}</p>}
              </div>
            )}

            {/* Имя получателя — по нему флорист ищет заказ в Burq. */}
            <div>
              <div className="text-xs text-slate-400">Получатель</div>
              <div className="text-base font-semibold text-slate-900">{view.recipientName}</div>
            </div>

            {/* Открыть Burq Dashboard + подсказки. */}
            <div className="space-y-1">
              <a href={view.dashboardUrl} target="_blank" rel="noopener noreferrer">
                <Button type="button" size="sm">Открыть Burq Dashboard</Button>
              </a>
              <p className="text-xs text-slate-600">{view.findByNameText}</p>
              <p className="text-[11px] text-amber-700">{view.modeHint}</p>
            </div>

            {/* Стоимость доставки (факт) — только Uber, появляется после dispatch. Для отменённой
                попытки не показываем (её сумма — в истории). */}
            {!isCancelledAttempt && (
            <div className="rounded-md border border-slate-200 bg-slate-50 p-2">
              {delivery.finalCost != null ? (
                <div className="space-y-0.5">
                  <div className="text-xs text-slate-500">Provider: <span className="font-medium text-slate-700">Uber</span></div>
                  <div className="text-sm">
                    Доставка (факт): <span className="font-semibold text-slate-900">${delivery.finalCost.toFixed(2)}</span>
                    {delivery.currency && delivery.currency.toUpperCase() !== "USD" && <span className="ml-1 text-xs text-slate-400">{delivery.currency.toUpperCase()}</span>}
                  </div>
                  {delivery.finalCostUpdatedAt && (
                    <div className="text-[11px] text-slate-400">обновлено: {new Date(delivery.finalCostUpdatedAt).toLocaleString()}</div>
                  )}
                </div>
              ) : (
                <div className="text-xs text-slate-500">Стоимость появится после выбора Uber и отправки доставки в Burq.</div>
              )}
            </div>
            )}

            {/* Burq Order ID — мелкий служебный текст для диагностики. */}
            {view.orderIdDiagnostic && (
              <div className="text-[11px] text-slate-400">Burq Order ID (диагностика): {view.orderIdDiagnostic}</div>
            )}

            {isProblem && (
              <div className="rounded-md border border-red-200 bg-red-50 p-3">
                <div className="mb-2 text-xs font-semibold text-red-700">
                  Доставка требует ручного решения. Автоматические уведомления и повторы отключены.
                </div>
                <form action={action} className="flex flex-wrap gap-2">
                  <input type="hidden" name="deliveryId" value={delivery.id} />
                  <input type="hidden" name="orderId" value={orderId} />
                  <Button type="submit" size="sm" variant="outline" name="decision" value="mark_delivered" disabled={pending}>
                    Отметить доставленным
                  </Button>
                  <Button type="submit" size="sm" variant="outline" name="decision" value="mark_cancelled" disabled={pending}>
                    Отметить отменённым
                  </Button>
                  <Button type="submit" size="sm" variant="outline" name="decision" value="record_refund" disabled={pending}>
                    Зафиксировать возврат
                  </Button>
                  <Button type="submit" size="sm" variant="ghost" name="decision" value="leave_problem" disabled={pending}>
                    Оставить как есть
                  </Button>
                </form>
              </div>
            )}
          </>
        )}

        {state?.error && <p className="text-xs text-red-600">{state.error}</p>}
        {state?.ok && <p className="text-xs text-emerald-700">{state.message}</p>}

        {/* История попыток доставки Burq (по умолчанию свёрнута). Основной блок — только текущая. */}
        {attempts.length > 1 && (
          <details className="rounded-lg border border-slate-200 bg-slate-50 p-2 text-xs">
            <summary className="cursor-pointer font-medium text-slate-600">История доставок Burq ({attempts.length})</summary>
            <ul className="mt-2 space-y-2">
              {attempts.map((a) => (
                <li key={a.attemptNumber} className="rounded border border-slate-200 bg-white p-2">
                  <div className="flex items-center justify-between">
                    <span className="font-medium text-slate-700">Attempt {a.attemptNumber}</span>
                    <span className={RETRYABLE.has(a.status) ? "text-red-600" : a.status === "DELIVERED" ? "text-emerald-600" : "text-slate-500"}>{STATUS_RU[a.status] ?? a.status}</span>
                  </div>
                  <div className="mt-0.5 text-[11px] text-slate-400">
                    создана: {new Date(a.createdAt).toLocaleString()}
                    {a.deliveredAt && ` · доставлена: ${new Date(a.deliveredAt).toLocaleString()}`}
                    {a.cancelledAt && ` · отменена: ${new Date(a.cancelledAt).toLocaleString()}`}
                  </div>
                  <div className="mt-0.5 text-[11px] text-slate-500">
                    {a.finalCost != null && <span>стоимость: ${a.finalCost.toFixed(2)}{a.currency && a.currency.toUpperCase() !== "USD" ? ` ${a.currency.toUpperCase()}` : ""} · </span>}
                    {a.floristName && <span>флорист: {a.floristName} · </span>}
                    {a.cancellationReason && <span>причина: {a.cancellationReason} · </span>}
                    {a.externalDeliveryId && <span className="text-slate-400">Burq: {a.externalDeliveryId}</span>}
                  </div>
                </li>
              ))}
            </ul>
          </details>
        )}
      </CardBody>
    </Card>
  );
}
