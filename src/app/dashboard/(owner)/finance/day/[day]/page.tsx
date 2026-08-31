import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronRight } from "lucide-react";
import { requireRole } from "@/lib/rbac";
import { PageHeader } from "@/components/ui/misc";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/Badge";
import { formatCents } from "@/lib/cents";
import { getOwnerDay } from "@/modules/finance/ownerDashboard";
import { incompleteSummary, incompleteOrderHref } from "@/lib/financeMissing";

export const dynamic = "force-dynamic";

const MONTHS_GENITIVE = [
  "января", "февраля", "марта", "апреля", "мая", "июня",
  "июля", "августа", "сентября", "октября", "ноября", "декабря",
];

const BLOCKER_LABEL: Record<string, string> = {
  DAILY_FLOWER_EXPENSE_MISSING: "не внесена закупка цветов",
  ORDER_DATA_INCOMPLETE: "по заказам не хватает данных",
};

/**
 * Разбор дня: почему прибыль получилась именно такой.
 *
 * Три блока отвечают на три вопроса подряд — откуда деньги, куда ушли, сколько забрали
 * флористы, — и в конце остаётся одна цифра. Каждый блок разворачивается дальше: флорист
 * до своих заказов, заказ до карточки.
 *
 * Список моих расходов здесь НЕ дублируется: для него есть свой раздел, и вести туда —
 * дешевле, чем поддерживать вторую копию того же списка.
 */
export default async function OwnerFinanceDayPage({ params }: { params: Promise<{ day: string }> }) {
  await requireRole("OWNER");
  const { day } = await params;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) notFound();

  const date = new Date(`${day}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) notFound();

  const detail = await getOwnerDay(date);
  if (!detail) notFound();

  const title = `${date.getUTCDate()} ${MONTHS_GENITIVE[date.getUTCMonth()]} ${date.getUTCFullYear()}`;

  return (
    <div className="space-y-4">
      <PageHeader
        title={title}
        description={`${detail.ordersTotal} ${detail.ordersTotal === 1 ? "заказ" : detail.ordersTotal < 5 ? "заказа" : "заказов"}`}
        actions={
          <Button asChild variant="outline">
            <Link href="/dashboard/finance">К обзору</Link>
          </Button>
        }
      />

      {!detail.ready && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge className="border-amber-300 bg-white text-amber-800">Не готов к расчёту</Badge>
            <span className="text-sm text-amber-900">
              {detail.blockers.map((b) => BLOCKER_LABEL[b] ?? b).join(", ")}
            </span>
          </div>
          <p className="mt-1 text-xs text-amber-700">
            Пока данных не хватает, прибыль за этот день не считается и в итог месяца не входит.
          </p>
        </div>
      )}

      {/* Называем заказы поимённо — ОТДЕЛЬНО от баннера готовности: «не задана цена флориста»
          день не блокирует, но дополнить её всё равно нужно, и прятать строку на готовом дне
          значило бы спорить с обзором флористов. Дверь у каждой причины своя (см.
          incompleteOrderHref): расходы чинятся в финансовом разборе, цена — в карточке заказа. */}
      {detail.incompleteOrders.length > 0 && (
        <div className="rounded-xl border border-amber-200 bg-amber-50/60 px-4 py-3">
          <div className="text-xs font-medium text-amber-900">Заказы, которые нужно дополнить</div>
          <ul className="mt-2 space-y-1">
            {detail.incompleteOrders.map((o) => (
              <li key={o.id} className="text-xs text-amber-900">
                <Link href={incompleteOrderHref(o)} className="font-medium underline underline-offset-2">
                  {o.orderNumber}
                </Link>
                <span className="text-amber-700"> — {incompleteSummary(o)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Выручка</CardTitle>
        </CardHeader>
        <CardBody className="p-0">
          <dl className="divide-y divide-slate-100">
            {detail.revenueBySite.map((s) => (
              <LineRow key={s.siteId} label={s.name} cents={s.cents} />
            ))}
            <LineRow label="Итого" cents={detail.revenueCents} strong />
          </dl>
          {detail.tipsCents > 0 && (
            <p className="border-t border-slate-100 px-4 py-2 text-xs text-slate-400">
              Из них чаевые {formatCents(detail.tipsCents)} — целиком ваши, флористу с них ничего не идёт.
            </p>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Расходы бизнеса</CardTitle>
        </CardHeader>
        <CardBody className="p-0">
          <dl className="divide-y divide-slate-100">
            {detail.expenses.map((e) =>
              e.label === "Мои расходы" ? (
                <div key={e.label} className="flex items-baseline justify-between gap-3 px-4 py-2">
                  <dt className="flex items-center gap-2 text-slate-500">
                    Мои расходы
                    <Link
                      href={`/dashboard/expenses?tab=history&day=${detail.day}`}
                      className="text-xs text-slate-400 underline-offset-2 hover:text-slate-700 hover:underline"
                    >
                      посмотреть
                    </Link>
                  </dt>
                  <dd className="tabular-nums text-slate-700">{formatCents(e.cents)}</dd>
                </div>
              ) : (
                <LineRow key={e.label} label={e.label} cents={e.cents} />
              )
            )}
            <LineRow label="Итого" cents={detail.expensesCents} strong />
          </dl>
          {detail.taxCollectedCents > detail.expenses.find((e) => e.label === "Налог")!.cents && (
            <p className="border-t border-slate-100 px-4 py-2 text-xs text-slate-400">
              Собрано налога {formatCents(detail.taxCollectedCents)}, но вашим расходом считается только доля из
              «Настроек расчёта» — остальное остаётся у вас.
            </p>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Флористы</CardTitle>
        </CardHeader>
        <CardBody className="p-0">
          <ul className="divide-y divide-slate-100">
            {detail.florists.map((f) => (
              <li key={f.floristId}>
                <details className="group">
                  <summary className="flex cursor-pointer list-none items-baseline justify-between gap-3 px-4 py-2 hover:bg-slate-50/60 [&::-webkit-details-marker]:hidden">
                    <span className="flex items-center gap-2 text-slate-700">
                      <ChevronRight
                        aria-hidden
                        className="size-4 shrink-0 text-slate-400 transition-transform group-open:rotate-90"
                      />
                      {f.name}
                      <span className="text-xs text-slate-400">
                        {f.orders.length} {f.orders.length === 1 ? "заказ" : f.orders.length < 5 ? "заказа" : "заказов"}
                      </span>
                    </span>
                    <span className="tabular-nums text-slate-700">{formatCents(f.cents)}</span>
                  </summary>
                  <ul className="pb-2 pl-11 pr-4">
                    {f.orders.map((o) => (
                      <li key={o.id}>
                        <Link
                          href={`/dashboard/orders/${o.id}`}
                          className="flex items-baseline justify-between gap-3 py-1 text-sm hover:underline"
                        >
                          <span className="text-slate-600">{o.orderNumber}</span>
                          <span className="tabular-nums text-slate-500">
                            {o.contributionCents >= 0 ? "+" : "−"}
                            {formatCents(Math.abs(o.contributionCents))}
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </details>
              </li>
            ))}
            <LineRow label="Итого" cents={detail.floristEarningsCents} strong />
          </ul>
        </CardBody>
      </Card>

      <div className="flex items-baseline justify-between gap-3 rounded-xl border border-slate-200 bg-white px-4 py-4">
        <span className="font-medium text-slate-700">Моя прибыль</span>
        <span
          className={`text-2xl font-semibold tabular-nums ${
            detail.ownerNetCents == null
              ? "text-slate-300"
              : detail.ownerNetCents < 0
                ? "text-red-600"
                : "text-slate-900"
          }`}
        >
          {detail.ownerNetCents == null ? "не посчитана" : formatCents(detail.ownerNetCents)}
        </span>
      </div>
    </div>
  );
}

function LineRow({ label, cents, strong = false }: { label: string; cents: number; strong?: boolean }) {
  return (
    <div className={`flex items-baseline justify-between gap-3 px-4 py-2 ${strong ? "bg-slate-50/60" : ""}`}>
      <dt className={strong ? "font-medium text-slate-700" : "text-slate-500"}>{label}</dt>
      <dd className={`tabular-nums ${strong ? "font-semibold text-slate-900" : "text-slate-700"}`}>
        {formatCents(cents)}
      </dd>
    </div>
  );
}
