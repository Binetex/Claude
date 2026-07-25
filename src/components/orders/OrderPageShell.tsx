import Link from "next/link";
import { fmtDate, formatOrderNumber } from "@/lib/format";

/**
 * Общий каркас карточки заказа: ссылка назад, шапка с номером и бейджами, полоса доставки
 * и сетка «широкая колонка + узкая колонка управления».
 *
 * Вынесен, чтобы владелец и флорист не расходились в вёрстке: раньше у флориста была своя
 * узкая одноколоночная страница (max-w-2xl), и любая правка компоновки делалась дважды.
 * Роль задаёт ТОЛЬКО содержимое колонок — сетка, отступы и ширины общие.
 */
export function OrderPageShell({
  backHref,
  backLabel,
  orderNumber,
  siteName,
  badges,
  deliveryDate,
  deliveryWindow,
  left,
  right,
}: {
  backHref: string;
  backLabel: string;
  orderNumber: string;
  siteName: string;
  badges?: React.ReactNode;
  deliveryDate: Date | string;
  deliveryWindow?: string | null;
  left: React.ReactNode;
  /** Узкая колонка управления. Прилипает при прокрутке — как у владельца. */
  right: React.ReactNode;
}) {
  return (
    <div className="space-y-4">
      <Link href={backHref} className="text-sm text-slate-500 hover:underline">← {backLabel}</Link>

      {/* Шапка */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h1 className="text-xl font-semibold text-slate-900">{formatOrderNumber(orderNumber)}</h1>
        <span className="text-sm text-slate-500">{siteName}</span>
        {badges && <div className="flex flex-wrap gap-1.5">{badges}</div>}
      </div>

      {/* Доставка — крупно */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-slate-200 bg-white px-4 py-2.5">
        <span className="text-xs tracking-wide text-slate-400 uppercase">Доставка</span>
        <span className="text-base font-semibold text-slate-900">{fmtDate(deliveryDate)}</span>
        {deliveryWindow && <span className="text-base font-bold text-slate-900">{deliveryWindow}</span>}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">{left}</div>
        <div className="lg:col-span-1">
          <div className="sticky top-16 space-y-4">{right}</div>
        </div>
      </div>
    </div>
  );
}
