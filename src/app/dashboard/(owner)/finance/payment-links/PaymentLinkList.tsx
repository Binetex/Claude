"use client";
import { useState, useTransition } from "react";
import { Card, CardBody } from "@/components/ui/Card";
import { deactivatePaymentLinkAction } from "./actions";
import { fmtStoreDateTime } from "@/lib/tz";

/** Форма ссылки — повторена здесь, чтобы клиентский список не тянул server-only модуль клиента. */
export type PaymentLinkRow = {
  id: string;
  url: string;
  title: string;
  amount: number | null;
  status: string;
  active: boolean;
  createdAt: string | null;
};

/** Статусы Airwallex по-русски. Незнакомое показываем как есть — не гадаем. */
const STATUS_RU: Record<string, string> = { PAID: "оплачена", UNPAID: "ждёт оплаты", EXPIRED: "истекла", CANCELLED: "отменена" };

/**
 * Последние ссылки — прямо от Airwallex. Нужны не ради отчёта, а чтобы переслать ссылку
 * повторно («клиент потерял») и увидеть, заплатил ли он.
 */
export function PaymentLinkList({ links }: { links: PaymentLinkRow[] }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  if (links.length === 0) return null;
  return (
    <Card>
      <CardBody>
        <p className="mb-2 text-sm font-medium text-slate-800">Последние ссылки</p>
        {error && <p className="mb-2 rounded bg-rose-50 px-2 py-1 text-xs text-rose-700">{error}</p>}
        <ul className="divide-y divide-slate-100">
          {links.map((l) => {
            const paid = l.status === "PAID";
            // Гасить можно только неоплаченную и ещё живую: оплаченную Airwallex закрыл сам, а
            // кнопка на ней читалась бы как «отозвать деньги» — это делает возврат, и только он.
            const canDeactivate = !paid && l.active;
            return (
              <li key={l.id} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 py-2">
                <div className="min-w-0">
                  <a href={l.url} target="_blank" rel="noopener noreferrer" className="break-all text-sm text-sky-700 hover:underline">
                    {l.title || l.url}
                  </a>
                  <div className="text-[11px] text-slate-400">
                    {l.createdAt ? fmtStoreDateTime(l.createdAt, null) : "—"}
                  </div>
                </div>
                <div className="shrink-0 text-right">
                  <div className="text-sm font-semibold tabular-nums text-slate-800">
                    {l.amount != null ? `$${l.amount.toFixed(2)}` : "—"}
                  </div>
                  <div className={"text-[11px] " + (paid ? "text-emerald-700" : "text-slate-400")}>
                    {l.active ? STATUS_RU[l.status] ?? l.status : "погашена"}
                  </div>
                  {canDeactivate && (
                    <button
                      type="button"
                      disabled={pending}
                      className="mt-0.5 text-[11px] text-slate-500 underline hover:text-rose-600 disabled:opacity-40"
                      onClick={() => {
                        if (!confirm(`Погасить ссылку «${l.title}»? Оплатить по ней больше будет нельзя.`)) return;
                        start(async () => {
                          const res = await deactivatePaymentLinkAction(l.id);
                          setError(res.error ?? null);
                        });
                      }}
                    >
                      Погасить
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </CardBody>
    </Card>
  );
}
