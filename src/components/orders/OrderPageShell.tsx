import Link from "next/link";
import { CalendarDays, ChevronLeft } from "lucide-react";
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
  deliveryAction,
  left,
  right,
  rightFirstOnMobile = false,
}: {
  backHref: string;
  backLabel: string;
  orderNumber: string;
  siteName: string;
  badges?: React.ReactNode;
  deliveryDate: Date | string;
  deliveryWindow?: string | null;
  /**
   * Действие рядом с датой доставки — обычно иконка редактирования, открывающая модалку.
   * Слот, а не флаг: страница сама решает, можно ли ей править дату, и шапка не знает
   * ни про роли, ни про OCC.
   */
  deliveryAction?: React.ReactNode;
  left: React.ReactNode;
  /** Узкая колонка управления. Прилипает при прокрутке — как у владельца. */
  right: React.ReactNode;
  /**
   * На телефоне поднять колонку управления НАД содержимым. Флористу с телефона в руках
   * первыми нужны цена, статус и быстрые действия, а не список товаров: иначе до них
   * приходится прокручивать всю страницу. На широком экране порядок обычный.
   */
  rightFirstOnMobile?: boolean;
}) {
  return (
    <div className="space-y-4">
      <Link
        href={backHref}
        className="group inline-flex items-center gap-1 text-sm text-slate-500 transition-colors hover:text-slate-900"
      >
        <ChevronLeft className="size-4 transition-transform group-hover:-translate-x-0.5" />
        {backLabel}
      </Link>

      {/* Шапка. Номер — tabular-nums: цифры одной ширины, и заголовок не «дышит» при
          переходе между заказами. Магазин отделён точкой, а не пустотой. */}
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-2">
        <h1 className="text-xl font-semibold tracking-tight text-slate-900 tabular-nums">
          {formatOrderNumber(orderNumber)}
        </h1>
        <span className="text-sm text-slate-400">·</span>
        <span className="text-sm text-slate-500">{siteName}</span>
        {badges && <div className="flex flex-wrap gap-1.5">{badges}</div>}
      </div>

      {/* Доставка — единственная строка, которую флорист читает первой, поэтому у неё
          собственная плоскость: иконка-якорь слева, дата и интервал крупно, действие справа. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 shadow-sm">
        <CalendarDays className="size-4 shrink-0 text-slate-400" />
        <span className="text-[11px] font-medium tracking-wider text-slate-400 uppercase">Доставка</span>
        <span className="text-base font-semibold text-slate-900 tabular-nums">{fmtDate(deliveryDate)}</span>
        {deliveryWindow && (
          <span className="text-base font-semibold text-slate-900 tabular-nums">{deliveryWindow}</span>
        )}
        {deliveryAction && <span className="ml-auto">{deliveryAction}</span>}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className={`space-y-4 lg:col-span-2 ${rightFirstOnMobile ? "order-2 lg:order-none" : ""}`}>{left}</div>
        <div className={`lg:col-span-1 ${rightFirstOnMobile ? "order-1 lg:order-none" : ""}`}>
          <div className="sticky top-16 space-y-4">{right}</div>
        </div>
      </div>
    </div>
  );
}
