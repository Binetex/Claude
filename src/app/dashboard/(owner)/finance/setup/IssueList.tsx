import "server-only";
/**
 * Очередь незаполненного: показать, чего не хватает, и увести туда, где это правят.
 *
 * Раньше здесь были формы исправления прямо в карточке — с предпросмотром, подсказками
 * и массовыми действиями. За всё время работы ими не воспользовались ни разу: все 154
 * проблемы закрылись сами, когда данные появились через обычные экраны настроек и
 * расходов. Чинилка дублировала эти экраны, тянула подсказки запросом на каждую карточку
 * и требовала собственного предпросмотра — при том что настоящей работы не делала.
 *
 * Осталось то, что оказалось полезным: детектор и понятный список со ссылкой.
 */
import Link from "next/link";
import { Badge } from "@/components/ui/Badge";
import { formatCents } from "@/lib/cents";
import { dayKey } from "@/modules/finance/snapshot";
import type { FinanceIssueSeverity, FinanceIssueType } from "@/generated/prisma/enums";

export type IssueRow = {
  id: string;
  type: FinanceIssueType;
  severity: FinanceIssueSeverity;
  scopeDate: Date | null;
  siteId: string | null;
  orderId: string | null;
  estimatedImpactCents: number | null;
  site: { shortName: string } | null;
  order: { orderNumber: string } | null;
};

const severityMeta: Record<FinanceIssueSeverity, { label: string; className: string }> = {
  BLOCKING: { label: "блокирует", className: "border-red-200 bg-red-50 text-red-700" },
  WARNING: { label: "неточность", className: "border-amber-200 bg-amber-50 text-amber-800" },
  INFO: { label: "к сведению", className: "border-slate-200 bg-slate-50 text-slate-600" },
};

const typeTitles: Record<FinanceIssueType, string> = {
  DELIVERY_ACTUAL_COST_MISSING: "Не подтверждена фактическая доставка",
  ACQUIRING_FEE_MODEL_MISSING: "Не задана модель комиссии магазина",
  DAILY_FLOWER_EXPENSE_MISSING: "Не внесена дневная закупка цветов",
  VASE_COST_MISSING: "Неизвестна закупочная стоимость вазы",
  GIFT_COST_MISSING: "Неизвестна закупочная стоимость подарка",
  VASE_LINK_MISSING: "У букета не указана ваза",
  CONSUMABLES_RATE_MISSING: "Не задана ставка расходников",
  OWNER_TAX_POLICY_MISSING: "Не задана налоговая политика",
  FLOWER_REVENUE_UNDETERMINED: "Не классифицированы позиции заказа",
};

/**
 * Куда идти чинить. Ровно один экран на тип проблемы — тот же, которым пользуются
 * в обычной работе, без второго пути записи.
 */
function fixLink(issue: IssueRow): { href: string; label: string } {
  switch (issue.type) {
    case "DELIVERY_ACTUAL_COST_MISSING":
      return issue.orderId
        ? { href: `/dashboard/orders/${issue.orderId}`, label: "Открыть заказ" }
        : { href: "/dashboard/finance/setup/delivery", label: "Подтвердить доставки" };
    case "DAILY_FLOWER_EXPENSE_MISSING":
      return issue.scopeDate
        ? { href: `/dashboard/finance/flower-expenses/${dayKey(issue.scopeDate)}`, label: "Внести закупку" }
        : { href: "/dashboard/finance/flower-expenses", label: "Расходы на цветы" };
    case "ACQUIRING_FEE_MODEL_MISSING":
    case "CONSUMABLES_RATE_MISSING":
    case "OWNER_TAX_POLICY_MISSING":
      return { href: "/dashboard/finance/settings", label: "Настройки расчёта" };
    case "VASE_COST_MISSING":
    case "GIFT_COST_MISSING":
    case "VASE_LINK_MISSING":
    case "FLOWER_REVENUE_UNDETERMINED":
      return { href: "/dashboard/products", label: "Открыть каталог" };
  }
}

export function IssueList({ issues }: { issues: IssueRow[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-slate-100 text-left text-[11px] tracking-wide text-slate-400 uppercase">
            <th className="px-4 py-2.5 font-medium">Что не заполнено</th>
            <th className="px-3 py-2.5 font-medium">Важность</th>
            <th className="px-3 py-2.5 font-medium">Где</th>
            <th className="px-3 py-2.5 font-medium">День</th>
            <th className="px-3 py-2.5 text-right font-medium">На кону</th>
            <th className="px-4 py-2.5 text-right font-medium">Действие</th>
          </tr>
        </thead>
        <tbody>
          {issues.map((i) => {
            const link = fixLink(i);
            return (
              <tr key={i.id} className="border-b border-slate-50 last:border-0 hover:bg-slate-50/60">
                <td className="px-4 py-2.5 text-slate-800">{typeTitles[i.type]}</td>
                <td className="px-3 py-2.5">
                  <Badge className={severityMeta[i.severity].className}>{severityMeta[i.severity].label}</Badge>
                </td>
                <td className="px-3 py-2.5 text-slate-500">
                  {i.order ? i.order.orderNumber : (i.site?.shortName ?? "все магазины")}
                </td>
                <td className="px-3 py-2.5 tabular-nums text-slate-500">
                  {i.scopeDate ? dayKey(i.scopeDate) : "—"}
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums text-slate-500">
                  {i.estimatedImpactCents != null ? formatCents(i.estimatedImpactCents) : "—"}
                </td>
                <td className="px-4 py-2.5 text-right whitespace-nowrap">
                  <Link href={link.href} className="text-sm text-blue-600 hover:underline">
                    {link.label}
                  </Link>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
