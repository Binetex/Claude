import Link from "next/link";
import { notFound } from "next/navigation";
import { requireRole } from "@/lib/rbac";
import { prisma } from "@/lib/db";
import { PageHeader } from "@/components/ui/misc";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/states";
import { formatCents } from "@/lib/cents";
import { readOrderContribution } from "@/modules/finance/dayFinance";

export const dynamic = "force-dynamic";

const missingLabels: Record<string, string> = {
  DELIVERY_ACTUAL_COST: "фактическая доставка",
  ACQUIRING_FEE: "комиссия эквайринга",
  VASE_GIFT_COST: "закупка вазы или подарка",
  CONSUMABLES_RATE: "ставка расходников",
};

export default async function OrderFinancePage({ params }: { params: Promise<{ orderId: string }> }) {
  await requireRole("OWNER");
  const { orderId } = await params;

  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      orderNumber: true,
      deliveryDate: true,
      currentFloristId: true,
      site: { select: { shortName: true } },
    },
  });
  if (!order) notFound();

  // Ревизий здесь нет и не будет: они объясняли историю пересчётов, а объяснять нужно
  // историю денег — она видна в книге, где у каждой записи свои цифры.
  const calc = await readOrderContribution(orderId);

  return (
    <div className="space-y-4">
      <PageHeader
        title={`Финансовый разбор · ${order.orderNumber}`}
        description={`${order.site.shortName} · доставка ${order.deliveryDate.toISOString().slice(0, 10)}`}
        actions={
          <div className="flex items-center gap-3 text-sm">
            <Link href={`/dashboard/orders/${order.id}`} className="text-slate-500 hover:text-slate-800">
              К заказу
            </Link>
            {/* День живёт в кабинете флориста: отдельного раздела «Доля основного
                флориста» больше нет. Без исполнителя вести некуда — ссылки нет. */}
            {order.currentFloristId && (
              <Link
                href={`/dashboard/finance/florists/${order.currentFloristId}/day/${order.deliveryDate.toISOString().slice(0, 10)}`}
                className="text-slate-500 hover:text-slate-800"
              >
                К дню
              </Link>
            )}
          </div>
        }
      />

      {!calc ? (
        <Card>
          <CardBody>
            <EmptyState
              title="Расчёт по заказу недоступен"
              description="Заказ не назначен основному флористу или ещё не доставлен."
            />
          </CardBody>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Вклад в прибыль дня {calc.day}</CardTitle>
          </CardHeader>
          <CardBody className="space-y-4">
            {calc.order.missing.length > 0 && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                Заказ не участвует в расчёте. Не хватает:{" "}
                {calc.order.missing.map((m) => missingLabels[m] ?? m).join(", ")}.
                <div className="mt-1 text-xs">
                  Пока данных нет, весь день не считается: подставить ноль вместо неизвестного расхода значило бы
                  завысить прибыль.
                </div>
              </div>
            )}

            <table className="w-full text-sm">
              <tbody>
                <Row label="Получено от клиента (товары + налог + доставка + чаевые)" cents={calc.order.grossRevenueCents} />
                <Row label="Чаевые (принадлежат владельцу)" cents={-calc.order.tipCents} />
                <Row label="Полный Tax Reserve" cents={-calc.order.taxCents} />
                <Row label="Фактическая доставка" cents={-(calc.order.deliveryActualCents ?? 0)} />
                <Row label="Комиссия эквайринга" cents={-(calc.order.acquiringFeeCents ?? 0)} />
                <Row label="Закупка ваз и подарков" cents={-(calc.order.vaseGiftCostCents ?? 0)} />
                <Row label="Расходники" cents={-(calc.order.consumablesCents ?? 0)} />
                {calc.order.additionalCents > 0 && (
                  <Row label="Дополнительные расходы по заказу" cents={-calc.order.additionalCents} />
                )}
                <tr className="border-t border-slate-200">
                  <td className="py-2 font-medium text-slate-800">Вклад в прибыль дня</td>
                  <td
                    className={`py-2 text-right font-semibold tabular-nums ${
                      calc.order.contributionCents < 0 ? "text-red-600" : "text-slate-900"
                    }`}
                  >
                    {formatCents(calc.order.contributionCents)}
                  </td>
                </tr>
              </tbody>
            </table>

            <p className="text-xs text-slate-400">
              Закупка цветов вычитается на уровне дня целиком, а не разносится по заказам — поэтому её здесь нет.
            </p>
          </CardBody>
        </Card>
      )}
    </div>
  );
}

function Row({ label, cents }: { label: string; cents: number }) {
  return (
    <tr className="border-b border-slate-50">
      <td className="py-1.5 text-slate-600">{label}</td>
      <td className={`py-1.5 text-right tabular-nums ${cents < 0 ? "text-slate-700" : "text-slate-900"}`}>
        {formatCents(cents)}
      </td>
    </tr>
  );
}
