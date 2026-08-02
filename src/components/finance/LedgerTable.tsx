import Link from "next/link";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/states";
import { formatCents } from "@/lib/cents";
import { cn } from "@/lib/cn";
import type { LedgerDirection, LedgerEntryType } from "@/generated/prisma/enums";

/**
 * История операций. Один компонент на владельца и на флориста: разница только в том,
 * что владельцу дополнительно рендерится колонка действий (проп `actions`), а флористу —
 * нет. Автора операции флорист не видит: кто именно из владельцев нажал кнопку, ему
 * ничего не объясняет, а имена сотрудников наружу отдавать незачем.
 */

export const ledgerTypeMeta: Record<LedgerEntryType, { label: string; className: string }> = {
  ORDER_ACCRUAL: { label: "Начисление", className: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  PRIMARY_FLORIST_SHARE: { label: "Доля за период", className: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  BONUS: { label: "Бонус", className: "bg-sky-50 text-sky-700 border-sky-200" },
  DEDUCTION: { label: "Удержание", className: "bg-amber-50 text-amber-800 border-amber-200" },
  PAYMENT: { label: "Выплата", className: "bg-slate-100 text-slate-700 border-slate-200" },
  PAYMENT_REVERSAL: { label: "Отмена выплаты", className: "bg-orange-50 text-orange-800 border-orange-200" },
  MANUAL_ADJUSTMENT: { label: "Корректировка", className: "bg-violet-50 text-violet-700 border-violet-200" },
  CORRECTION: { label: "Исправление", className: "bg-orange-50 text-orange-800 border-orange-200" },
};

export type LedgerRow = {
  id: string;
  type: LedgerEntryType;
  direction: LedgerDirection;
  amountCents: number;
  effectiveDate: Date;
  description: string;
  comment: string | null;
  orderId: string | null;
  orderNumberSnapshot: string | null;
  isReversed: boolean;
  isReversal: boolean;
};

/** Дата бизнес-операции: UTC-календарный день, без пересчёта через таймзону. */
function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function LedgerTable({
  rows,
  orderHrefBase,
  actions,
}: {
  rows: LedgerRow[];
  /** База ссылки на заказ: у владельца /dashboard/orders, у флориста /dashboard/f. */
  orderHrefBase: string;
  /** Слот действий владельца (отмена). У флориста не передаётся — колонки не будет. */
  actions?: (row: LedgerRow) => React.ReactNode;
}) {
  if (rows.length === 0) {
    return <EmptyState title="Операций нет" description="Здесь появятся начисления, бонусы и выплаты." />;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-slate-100 text-left text-[11px] tracking-wide text-slate-400 uppercase">
            <th className="py-2 pr-3 font-medium">Дата</th>
            <th className="py-2 pr-3 font-medium">Операция</th>
            <th className="py-2 pr-3 font-medium">Описание</th>
            <th className="py-2 pr-3 font-medium">Заказ</th>
            <th className="py-2 pr-3 text-right font-medium">Сумма</th>
            {actions && <th className="py-2 font-medium"></th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const meta = ledgerTypeMeta[r.type];
            const signed = r.direction === "CREDIT" ? r.amountCents : -r.amountCents;
            return (
              <tr
                key={r.id}
                className={cn(
                  "border-b border-slate-50 last:border-0",
                  // Отменённую операцию не вычёркиваем: сумма в книге осталась, её просто
                  // погасила зеркальная запись. Приглушаем, чтобы не искать глазами пару.
                  r.isReversed && "text-slate-400"
                )}
              >
                <td className="py-2.5 pr-3 whitespace-nowrap tabular-nums">{formatDate(r.effectiveDate)}</td>
                <td className="py-2.5 pr-3">
                  <Badge className={r.isReversed ? "border-slate-200 bg-slate-50 text-slate-400" : meta.className}>
                    {meta.label}
                  </Badge>
                </td>
                <td className="py-2.5 pr-3">
                  <div className="text-slate-700">{r.description}</div>
                  {r.comment && <div className="mt-0.5 text-xs text-slate-400">{r.comment}</div>}
                </td>
                <td className="py-2.5 pr-3 whitespace-nowrap">
                  {r.orderId && r.orderNumberSnapshot ? (
                    <Link href={`${orderHrefBase}/${r.orderId}`} className="text-blue-600 hover:underline">
                      {r.orderNumberSnapshot}
                    </Link>
                  ) : (
                    <span className="text-slate-300">—</span>
                  )}
                </td>
                <td
                  className={cn(
                    "py-2.5 pr-3 text-right font-medium whitespace-nowrap tabular-nums",
                    r.isReversed ? "text-slate-400" : signed >= 0 ? "text-emerald-700" : "text-slate-700"
                  )}
                >
                  {signed >= 0 ? "+" : "−"}
                  {formatCents(Math.abs(signed))}
                </td>
                {actions && <td className="py-2.5 text-right">{actions(r)}</td>}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Сводка баланса. Остаток — единственная цифра, которая что-то значит для выплаты. */
export function BalanceSummary({
  accruedCents,
  bonusCents,
  deductionCents,
  paidCents,
  outstandingCents,
}: {
  accruedCents: number;
  bonusCents: number;
  deductionCents: number;
  paidCents: number;
  outstandingCents: number;
}) {
  const item = (label: string, value: number, cls = "text-slate-900") => (
    <div>
      <div className="text-[11px] tracking-wide text-slate-400 uppercase">{label}</div>
      <div className={cn("mt-0.5 text-lg font-semibold tabular-nums", cls)}>{formatCents(value)}</div>
    </div>
  );

  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
      {item("Начислено", accruedCents)}
      {item("Бонусы", bonusCents)}
      {item("Удержания", deductionCents, deductionCents > 0 ? "text-amber-600" : "text-slate-900")}
      {item("Выплачено", paidCents)}
      {item(
        "К выплате",
        outstandingCents,
        // Минус означает переплату — это не «всё хорошо», это повод разобраться.
        outstandingCents < 0 ? "text-red-600" : "text-emerald-700"
      )}
    </div>
  );
}
