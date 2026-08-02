import Link from "next/link";
import { requireRole } from "@/lib/rbac";
import { prisma } from "@/lib/db";
import { PageHeader, StatCard } from "@/components/ui/misc";
import { Card, CardBody } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/states";
import { formatCents } from "@/lib/cents";
import { listOpenIssues, type IssueGroup } from "@/modules/finance/issues";
import { getIssueSummary } from "@/modules/finance/issues";
import { suggestDailyExpenseCents, suggestDeliveryCostCents } from "@/modules/finance/preview";
import { listVaseOptions } from "@/modules/catalog/finance/vaseLink";
import { dayKey } from "@/modules/finance/snapshot";
import { IssueCard, type IssueCardData } from "./IssueCard";
import { RescanButton, SetupFilters } from "./SetupControls";
import type { FinanceIssueType } from "@/generated/prisma/enums";

export const dynamic = "force-dynamic";

const groupTitles: Record<IssueGroup, string> = {
  TODAY: "Сегодня",
  LAST_7_DAYS: "Последние 7 дней",
  OLDER: "Старые",
  NO_DATE: "Без даты",
};

const GROUP_ORDER: IssueGroup[] = ["TODAY", "LAST_7_DAYS", "OLDER", "NO_DATE"];

export default async function FinanceSetupPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requireRole("OWNER");
  const sp = await searchParams;

  const [summary, issues, sites] = await Promise.all([
    getIssueSummary(),
    listOpenIssues({
      siteId: sp.site,
      type: sp.type as FinanceIssueType | undefined,
      group: sp.group as IssueGroup | undefined,
    }),
    prisma.site.findMany({ select: { id: true, shortName: true }, orderBy: { shortName: "asc" } }),
  ]);

  // Подсказки и списки ваз собираются на сервере: карточка не должна ходить за ними сама.
  const cards: IssueCardData[] = await Promise.all(
    issues.map(async (issue) => {
      const needsDelivery = issue.type === "DELIVERY_ACTUAL_COST_MISSING" && issue.orderId;
      const needsExpense = issue.type === "DAILY_FLOWER_EXPENSE_MISSING" && issue.scopeDate;
      const needsVases = issue.type === "VASE_LINK_MISSING" && issue.siteId;

      const [delivery, expense, vaseOptions] = await Promise.all([
        needsDelivery ? suggestDeliveryCostCents(issue.orderId!) : Promise.resolve(null),
        needsExpense ? suggestDailyExpense(issue.scopeDate!) : Promise.resolve(null),
        needsVases ? listVaseOptions(issue.siteId!) : Promise.resolve([]),
      ]);

      return {
        id: issue.id,
        type: issue.type,
        severity: issue.severity,
        scopeDate: issue.scopeDate ? dayKey(issue.scopeDate) : null,
        siteId: issue.siteId,
        siteShortName: issue.site?.shortName ?? null,
        orderId: issue.orderId,
        orderNumber: issue.order?.orderNumber ?? null,
        sourceEntityId: issue.sourceEntityId,
        detail: (issue.detailJson as Record<string, unknown> | null) ?? null,
        suggested: (issue.suggestedValueJson as Record<string, unknown> | null) ?? null,
        estimatedImpactCents: issue.estimatedImpactCents,
        suggestion: {
          ...(delivery ? { deliveryCents: delivery.cents, deliverySource: delivery.source } : {}),
          ...(expense != null ? { dailyExpenseCents: expense } : {}),
        },
        vaseOptions: vaseOptions.map((v) => ({ id: v.id, label: v.label, costCents: v.costCents })),
      };
    })
  );

  const byGroup = new Map<IssueGroup, IssueCardData[]>();
  for (let i = 0; i < issues.length; i++) {
    const g = issues[i].group;
    byGroup.set(g, [...(byGroup.get(g) ?? []), cards[i]]);
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Финансы — требует заполнения"
        description="Чего не хватает, чтобы посчитать долю основного флориста. Ассистент записывает только исходные данные — начисления он не создаёт."
        actions={
          <div className="flex items-center gap-2">
            <Link href="/dashboard/finance/settings" className="text-sm text-slate-500 hover:text-slate-800">
              Настройки
            </Link>
            <RescanButton />
          </div>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Блокирует" value={summary.blocking} tone={summary.blocking > 0 ? "danger" : "success"} />
        <StatCard label="Предупреждения" value={summary.warning} tone={summary.warning > 0 ? "warning" : "default"} />
        <StatCard label="Дней готово к расчёту" value={summary.readyDays} tone="success" />
        <StatCard
          label="Затронуто, ≈$"
          value={summary.estimatedImpactCents == null ? "неизвестно" : formatCents(summary.estimatedImpactCents)}
        />
      </div>

      <SetupFilters sites={sites} current={{ site: sp.site, type: sp.type, group: sp.group }} />

      {issues.length === 0 ? (
        <Card>
          <CardBody>
            <EmptyState
              title="Всё заполнено"
              description="Открытых проблем нет. Если данные изменятся, очередь наполнится сама при следующем прогоне детектора."
            />
          </CardBody>
        </Card>
      ) : (
        GROUP_ORDER.filter((g) => byGroup.get(g)?.length).map((group) => (
          <section key={group} className="space-y-2">
            <h2 className="text-sm font-medium text-slate-500">
              {groupTitles[group]} · {byGroup.get(group)!.length}
            </h2>
            <div className="space-y-3">
              {byGroup.get(group)!.map((card) => (
                <IssueCard key={card.id} issue={card} />
              ))}
            </div>
          </section>
        ))
      )}
    </div>
  );
}

/** Среднее за неделю для конкретного дня — предложение в карточке закупки. */
async function suggestDailyExpense(scopeDate: Date): Promise<number | null> {
  const profile = await prisma.floristFinanceProfile.findFirst({
    where: { model: "PRIMARY", active: true, effectiveTo: null },
    select: { id: true },
  });
  if (!profile) return null;
  return suggestDailyExpenseCents(profile.id, scopeDate);
}
