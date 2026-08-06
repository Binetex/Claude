"use client";
/**
 * Возврат денег клиенту. Кнопка + модалка.
 *
 * Операция необратима, поэтому интерфейс намеренно неудобный: состояние подгружается с
 * Airwallex при открытии (сколько оплачено и сколько уже вернули), сумму видно, и до кнопки
 * «Вернуть» нужно вручную набрать номер заказа. Одного клика недостаточно.
 *
 * `requestId` создаётся ОДИН РАЗ при открытии модалки и не меняется между попытками отправки:
 * это ключ идемпотентности Airwallex, и именно он не даёт вернуть деньги дважды, если форму
 * отправили повторно или ответ не дошёл.
 */
import { useActionState, useState } from "react";
import { Undo2, TriangleAlert } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createRefundAction, loadRefundState, type RefundFormState } from "./refundActions";
import type { RefundState } from "@/integrations/airwallex/refund";

const newRequestId = () =>
  typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;

export function RefundDialog({ orderId, orderNumber }: { orderId: string; orderNumber: string }) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<RefundState | null>(null);
  const [loading, setLoading] = useState(false);
  const [amount, setAmount] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [requestId, setRequestId] = useState(newRequestId);
  const [result, formAction, pending] = useActionState<RefundFormState, FormData>(createRefundAction, null);

  // Состояние тянем при КАЖДОМ открытии, а не один раз: возврат могли сделать из кабинета
  // Airwallex, пока страница висела открытой, и показывать устаревшую «доступную сумму»
  // здесь опасно. Загрузка висит на открытии, а не на эффекте: побочное действие тут —
  // ответ на клик, и в эффекте ему делать нечего.
  async function openDialog() {
    setOpen(true);
    setLoading(true);
    setConfirmation("");
    setRequestId(newRequestId());
    try {
      const s = await loadRefundState(orderId);
      setState(s);
      if (s.available) setAmount(String(s.availableAmount));
    } finally {
      setLoading(false);
    }
  }

  const confirmed = confirmation.trim().toLowerCase() === orderNumber.toLowerCase();
  const amountNum = Number(amount.replace(",", "."));
  const amountValid =
    state?.available === true && Number.isFinite(amountNum) && amountNum > 0 && amountNum <= state.availableAmount;

  return (
    <>
      <Button size="sm" variant="outline" onClick={openDialog}>
        <Undo2 className="size-4" />
        Вернуть деньги
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Возврат клиенту · {orderNumber}</DialogTitle>
          </DialogHeader>

          {loading && <p className="text-sm text-slate-500">Спрашиваем Airwallex…</p>}

          {!loading && state && !state.available && (
            <p className="rounded-md border border-amber-200 bg-amber-50 p-2 text-sm text-amber-800">{state.reason}</p>
          )}

          {!loading && state?.available && (
            <form action={formAction} className="space-y-3">
              <input type="hidden" name="orderId" value={orderId} />
              <input type="hidden" name="orderNumber" value={orderNumber} />
              <input type="hidden" name="requestId" value={requestId} />

              <dl className="rounded-md border border-slate-200 bg-slate-50 p-2.5 text-sm">
                <div className="flex justify-between">
                  <dt className="text-slate-500">Оплачено</dt>
                  <dd className="font-medium tabular-nums">{state.paidAmount} {state.currency}</dd>
                </div>
                {state.refundedAmount > 0 && (
                  <div className="mt-1 flex justify-between">
                    <dt className="text-slate-500">Уже возвращено</dt>
                    <dd className="font-medium tabular-nums text-amber-700">
                      {state.refundedAmount} {state.currency}
                    </dd>
                  </div>
                )}
                <div className="mt-1 flex justify-between border-t border-slate-200 pt-1">
                  <dt className="text-slate-500">Доступно к возврату</dt>
                  <dd className="font-semibold tabular-nums">{state.availableAmount} {state.currency}</dd>
                </div>
              </dl>

              <div>
                <Label htmlFor="refund-amount">Сумма возврата</Label>
                <Input
                  id="refund-amount"
                  name="amount"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  inputMode="decimal"
                  className="tabular-nums"
                />
                {!amountValid && amount.trim() !== "" && (
                  <p className="mt-1 text-xs text-red-600">
                    Сумма должна быть больше нуля и не больше {state.availableAmount} {state.currency}.
                  </p>
                )}
              </div>

              <div>
                <Label htmlFor="refund-reason">Причина (уйдёт в Airwallex)</Label>
                <Input id="refund-reason" name="reason" defaultValue="Requested by customer" />
              </div>

              <div className="rounded-md border border-red-200 bg-red-50 p-2.5">
                <p className="flex items-start gap-1.5 text-xs text-red-800">
                  <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
                  Деньги уйдут клиенту. Отменить возврат нельзя.
                </p>
                <Label htmlFor="refund-confirm" className="mt-2 block text-xs text-red-900">
                  Введите номер заказа <span className="font-semibold">{orderNumber}</span>, чтобы подтвердить
                </Label>
                <Input
                  id="refund-confirm"
                  name="confirmation"
                  value={confirmation}
                  onChange={(e) => setConfirmation(e.target.value)}
                  placeholder={orderNumber}
                  autoComplete="off"
                />
              </div>

              {result?.error && (
                <p className={result.unknown ? "text-sm font-medium text-amber-700" : "text-sm text-red-600"}>
                  {result.error}
                </p>
              )}
              {result?.ok && <p className="text-sm text-emerald-700">{result.message}</p>}

              <div className="flex justify-end gap-2">
                <Button type="button" variant="outline" size="sm" onClick={() => setOpen(false)}>
                  Закрыть
                </Button>
                <Button type="submit" size="sm" disabled={pending || !confirmed || !amountValid || !!result?.ok}>
                  {pending ? "Возвращаем…" : "Вернуть деньги"}
                </Button>
              </div>
            </form>
          )}

          {!loading && state?.available && state.refunds.length > 0 && (
            <div className="border-t border-slate-100 pt-2">
              <p className="mb-1 text-xs font-medium text-slate-500">Возвраты по этому платежу</p>
              <ul className="space-y-1 text-xs text-slate-600">
                {state.refunds.map((r) => (
                  <li key={r.id} className="flex justify-between gap-2">
                    <span className="truncate">{r.createdAt?.slice(0, 10) ?? "—"} · {r.status}</span>
                    <span className="tabular-nums">{r.amount} {r.currency}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
