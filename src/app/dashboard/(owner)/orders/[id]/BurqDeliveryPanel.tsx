"use client";
import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { ZoomableImage } from "@/components/ImageLightbox";
import { resolveDeliveryAction, createNewDeliveryAttemptAction, refetchPodAction } from "./deliveryActions";
import { BurqLinkForm } from "./BurqLinkForm";

export type DeliveryPanelData = {
  id: string;
  status: string;
  rawProviderStatus: string | null;
  attemptNumber: number;
  externalDeliveryId: string | null;
  finalCost: number | null;
  currency: string | null;
  providerName: string | null;
  finalCostUpdatedAt: string | null;
  courierName: string | null;
  courierPhone: string | null;
  proofOfDeliveryUrls: string[];
  signatureImageUrl: string | null;
} | null;

/** POD-миниатюра: по клику открывается крупно в лайтбоксе (без перехода по ссылке и без скачивания). */
function PodImage({ url }: { url: string }) {
  return <ZoomableImage src={url} alt="Proof of delivery" className="h-16 w-16 rounded border border-slate-200 object-cover" />;
}

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
  podPresent: boolean;
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
  delivery_date_past: "дата доставки уже прошла",
  draft_exists: "черновик уже существует",
};

/**
 * Секция «Доставка Burq» ВНУТРИ карточки «Статус доставки» (единый блок). Убраны: имя получателя,
 * кнопка перехода в кабинет Burq, инструкция поиска по имени и подсказка режима Live/Test.
 * Содержит: нормализованный + raw Burq статус, курьер, стоимость Uber (факт), Proof of delivery,
 * блок проблемы/отмены + новая попытка, ручную привязку Burq Order ID, историю попыток.
 */
export function BurqDeliveryPanel({
  orderId,
  delivery,
  intent,
  orderStatus,
  attempts,
}: {
  orderId: string;
  delivery: DeliveryPanelData;
  intent: IntentData;
  orderStatus: string;
  attempts: DeliveryAttempt[];
}) {
  const [state, action, pending] = useActionState(resolveDeliveryAction, null);
  const [retryState, retryAction, retryPending] = useActionState(createNewDeliveryAttemptAction, null);
  const [podState, podAction, podPending] = useActionState(refetchPodAction, null);
  const isProblem = delivery?.status === "PROBLEM";
  const isDelivered = delivery?.status === "DELIVERED";
  const isCancelledAttempt = !!delivery && RETRYABLE.has(delivery.status);
  const canRetry = isCancelledAttempt && !TERMINAL_ORDER.has(orderStatus);

  return (
    <div className="space-y-3 border-t border-slate-100 pt-3 text-sm">
      <div className="text-xs font-semibold tracking-wide text-slate-400 uppercase">Доставка Burq</div>

      {!delivery && (
        <div className="text-slate-500">
          Черновик доставки Burq ещё не создан.
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
          {/* Нормализованный + raw Burq статус. */}
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={
                "inline-flex items-center rounded-md px-2 py-0.5 text-xs font-semibold " +
                (isProblem || isCancelledAttempt
                  ? "bg-red-100 text-red-700"
                  : isDelivered
                    ? "bg-emerald-100 text-emerald-700"
                    : "bg-slate-100 text-slate-700")
              }
            >
              {STATUS_RU[delivery.status] ?? delivery.status}
            </span>
            {delivery.rawProviderStatus && <span className="text-[11px] text-slate-400">Burq: {delivery.rawProviderStatus}</span>}
            {delivery.attemptNumber > 1 && <span className="text-[11px] text-slate-400">попытка #{delivery.attemptNumber}</span>}
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

          {/* Курьер (Uber). */}
          {!isCancelledAttempt && delivery.courierName && (
            <div className="text-xs text-slate-600">
              Курьер: <span className="font-medium text-slate-800">{delivery.courierName}</span>
              {delivery.courierPhone && <span className="text-slate-500"> · {delivery.courierPhone}</span>}
            </div>
          )}

          {/* Стоимость доставки (факт) — только Uber, появляется после dispatch. */}
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

          {/* Proof of delivery — только для ТЕКУЩЕЙ попытки. */}
          {!isCancelledAttempt && (
            <div className="rounded-md border border-slate-200 bg-slate-50 p-2">
              <div className="mb-1 flex items-center justify-between">
                <span className="text-xs font-semibold text-slate-600">Proof of delivery</span>
                <form action={podAction}>
                  <input type="hidden" name="deliveryId" value={delivery.id} />
                  <input type="hidden" name="orderId" value={orderId} />
                  <Button type="submit" size="sm" variant="ghost" disabled={podPending}>{podPending ? "…" : "Обновить Proof of delivery"}</Button>
                </form>
              </div>
              {delivery.proofOfDeliveryUrls.length > 0 ? (
                <div className="flex flex-wrap gap-2">
                  {delivery.proofOfDeliveryUrls.map((u, i) => <PodImage key={i} url={u} />)}
                </div>
              ) : isDelivered ? (
                <div className="text-xs text-amber-700">Burq не вернул фотографию подтверждения доставки.</div>
              ) : (
                <div className="text-xs text-slate-500">Фото появится после доставки.</div>
              )}
              {delivery.signatureImageUrl && <div className="mt-1"><PodImage url={delivery.signatureImageUrl} /></div>}
              {podState?.ok && <p className="mt-1 text-[11px] text-emerald-700">{podState.message}</p>}
              {podState?.error && <p className="mt-1 text-[11px] text-red-600">{podState.error}</p>}
            </div>
          )}

          {/* Burq Order ID — мелкий служебный текст для диагностики. */}
          {delivery.externalDeliveryId && (
            <div className="text-[11px] text-slate-400">Burq Order ID (диагностика): {delivery.externalDeliveryId}</div>
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

      {/* История попыток доставки Burq (по умолчанию свёрнута). */}
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
                  <span>фото: {a.podPresent ? "есть" : "нет"} · </span>
                  {a.floristName && <span>флорист: {a.floristName} · </span>}
                  {a.cancellationReason && <span>причина: {a.cancellationReason} · </span>}
                  {a.externalDeliveryId && <span className="text-slate-400">Burq: {a.externalDeliveryId}</span>}
                </div>
              </li>
            ))}
          </ul>
        </details>
      )}

      {/* Ручная привязка существующего Burq Order (o_...) — доступна всегда. */}
      <BurqLinkForm orderId={orderId} />
    </div>
  );
}
