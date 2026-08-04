import { Card, CardBody } from "@/components/ui/Card";
import { formatMoney } from "@/lib/money";

/**
 * Цена флориста по заказу — отдельным заметным блоком наверху колонки управления.
 *
 * В широкой компоновке карточка уезжает в узкую колонку, поэтому цена не должна теряться
 * среди прочих блоков: тёмная плашка, крупная сумма. Высота минимальная — сразу под ней
 * стоит статус заказа, до которого нельзя заставлять тянуться.
 *
 * Один блок на флориста и владельца. Разница только в подписи и в том, что владелец может
 * цену ПРАВИТЬ: правка приходит слотом-иконкой, отдельной карточки под неё не заводится.
 */
export function OrderPriceCard({
  label,
  amount,
  hint,
  action,
}: {
  label: string;
  amount: number;
  /** Мелкая приписка под подписью — например, «цена задана вручную». */
  hint?: string;
  /** Иконка-действие (у владельца — правка ручной цены в модалке). */
  action?: React.ReactNode;
}) {
  return (
    <Card className="overflow-hidden border-slate-900 bg-slate-900">
      <CardBody className="flex items-center justify-between gap-3 px-4 py-3">
        <div className="min-w-0">
          <div className="text-xs font-medium text-slate-400">{label}</div>
          {hint && <div className="mt-0.5 text-[11px] text-slate-500">{hint}</div>}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <span className="text-2xl font-semibold tracking-tight text-white tabular-nums">
            {formatMoney(amount)}
          </span>
          {action}
        </div>
      </CardBody>
    </Card>
  );
}
