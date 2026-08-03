import { Card, CardBody } from "@/components/ui/Card";
import { formatMoney } from "@/lib/money";

/**
 * Стоимость заказа для флориста — отдельным заметным блоком.
 * В широкой компоновке карточка уезжает в колонку управления, поэтому цена не должна
 * теряться среди прочих блоков: тёмная плашка, крупная сумма. Высота при этом минимальная —
 * сразу под ней стоит статус заказа, до которого нельзя заставлять тянуться.
 */
export function FloristPriceCard({ floristTotal }: { floristTotal: number }) {
  return (
    <Card className="overflow-hidden border-slate-900 bg-slate-900">
      <CardBody className="flex items-center justify-between gap-3 px-4 py-3">
        <span className="text-xs font-medium text-slate-400">Ваша цена изготовления</span>
        <span className="text-2xl font-semibold tracking-tight text-white tabular-nums">
          {formatMoney(floristTotal)}
        </span>
      </CardBody>
    </Card>
  );
}
