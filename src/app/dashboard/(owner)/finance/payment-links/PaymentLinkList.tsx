import { Card, CardBody } from "@/components/ui/Card";
import { fmtStoreDateTime } from "@/lib/tz";
import type { AirwallexPaymentLink } from "@/integrations/airwallex/client";

/** Статусы Airwallex по-русски. Незнакомое показываем как есть — не гадаем. */
const STATUS_RU: Record<string, string> = { PAID: "оплачена", UNPAID: "ждёт оплаты", EXPIRED: "истекла", CANCELLED: "отменена" };

/**
 * Последние ссылки — прямо от Airwallex. Нужны не ради отчёта, а чтобы переслать ссылку
 * повторно («клиент потерял») и увидеть, заплатил ли он.
 */
export function PaymentLinkList({ links }: { links: AirwallexPaymentLink[] }) {
  if (links.length === 0) return null;
  return (
    <Card>
      <CardBody>
        <p className="mb-2 text-sm font-medium text-slate-800">Последние ссылки</p>
        <ul className="divide-y divide-slate-100">
          {links.map((l) => {
            const paid = l.status === "PAID";
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
                    {STATUS_RU[l.status] ?? l.status}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      </CardBody>
    </Card>
  );
}
