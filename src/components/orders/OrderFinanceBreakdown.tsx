import { Calculator } from "lucide-react";
import { Card, CardHeader, CardTitle, CardBody } from "@/components/ui/Card";
import { formatMoney } from "@/lib/money";

/**
 * Раскладка сумм заказа: из чего сложился счёт клиента.
 *
 * ЗДЕСЬ НЕТ И НЕ ДОЛЖНО БЫТЬ ПРИБЫЛИ. Прежний блок «Финансы» у владельца показывал
 * «≈ Прибыль» по плоской формуле computeEstimatedProfit (доход клиента минус цена флориста
 * и факт доставки). Она не знает ни про модели PRIMARY/SECONDARY, ни про резерв налога, ни
 * про дневной расчёт, поэтому её число расходилось с настоящим заработком и вводило в
 * заблуждение. Заработок и доля считаются финансовым модулем по дням — там, и только там.
 */
export type OrderFinanceView = {
  itemsTotal: number;
  tax: number;
  tip: number;
  discount: number;
  deliveryCustomerCost: number;
  customerTotal: number;
};

export function OrderFinanceBreakdown({
  title,
  finance,
}: {
  title: string;
  finance: OrderFinanceView;
}) {
  return (
    <Card>
      <CardHeader className="py-2.5"><CardTitle icon={Calculator}>{title}</CardTitle></CardHeader>
      <CardBody>
        {/* На телефоне — один столбец: в две колонки на 320px подпись «Доставка (заказчик)»
            налезает на сумму. */}
        <div className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2 md:grid-cols-3">
          <Row label="Сумма товаров" value={finance.itemsTotal} />
          <Row label="Итог заказчика" value={finance.customerTotal} />
          <Row label="Налог" value={finance.tax} />
          <Row label="Доставка (заказчик)" value={finance.deliveryCustomerCost} />
          <Row label="Чаевые" value={finance.tip} />
          <Row label="Скидка" value={finance.discount} />
        </div>
      </CardBody>
    </Card>
  );
}

function Row({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-slate-500">{label}</span>
      <span className="font-medium text-slate-800 tabular-nums">{formatMoney(value)}</span>
    </div>
  );
}
