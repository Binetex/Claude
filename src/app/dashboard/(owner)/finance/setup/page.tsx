import Link from "next/link";
import { requireRole } from "@/lib/rbac";
import { prisma } from "@/lib/db";
import { PageHeader, StatCard } from "@/components/ui/misc";
import { Card, CardBody } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/states";
import { formatCents } from "@/lib/cents";
import { listOpenIssues, getIssueSummary, type IssueGroup } from "@/modules/finance/issues";
import { listBurqDeliveryCandidates } from "@/modules/finance/fix";
import { dayKey } from "@/modules/finance/snapshot";
import { IssueList, type IssueRow } from "./IssueList";
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

/**
 * Очередь незаполненного.
 *
 * Экран только показывает и уводит туда, где правят. Форм исправления здесь больше нет:
 * ими не воспользовались ни разу — все проблемы закрывались сами, когда данные вносили
 * через обычные экраны. Второй путь записи убран вместе с ними.
 */
export default async function FinanceSetupPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requireRole("OWNER");
  const sp = await searchParams;

  const [summary, issues, sites, burqList] = await Promise.all([
    getIssueSummary(),
    listOpenIssues({
      siteId: sp.site,
      type: sp.type as FinanceIssueType | undefined,
      group: sp.group as IssueGroup | undefined,
    }),
    prisma.site.findMany({ select: { id: true, shortName: true }, orderBy: { shortName: "asc" } }),
    listBurqDeliveryCandidates(),
  ]);
  const burqCandidates = burqList.length;

  const byGroup = new Map<IssueGroup, IssueRow[]>();
  for (const issue of issues) {
    byGroup.set(issue.group, [...(byGroup.get(issue.group) ?? []), issue as IssueRow]);
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Финансы — требует заполнения"
        description="Чего не хватает, чтобы посчитать долю основного флориста. Список показывает проблему и ведёт на экран, где она правится."
        actions={
          <div className="flex items-center gap-3">
            {burqCandidates > 0 && (
              <Link
                href="/dashboard/finance/setup/delivery"
                className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                Доставка по Burq: {burqCandidates}
              </Link>
            )}
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

      {summary.disabledReason ? (
        <Card>
          <CardBody className="text-sm text-slate-600">
            <div className="font-medium text-slate-800">Расчёт доли не запущен</div>
            <div className="mt-1 text-slate-500">
              {summary.disabledReason}. Пока дата не задана, проверки не выполняются — система намеренно не требует
              приводить в порядок период, когда финансовые настройки ещё не существовали.
            </div>
          </CardBody>
        </Card>
      ) : (
        <div className="text-xs text-slate-400">
          Проверяются заказы с {dayKey(summary.startDate!)}. Более ранние считаются историческими: они не блокируют
          работу и не попадают в очередь, но остаются доступными, если понадобится пересчитать историю.
        </div>
      )}

      <SetupFilters sites={sites} current={{ site: sp.site, type: sp.type, group: sp.group }} />

      {issues.length === 0 ? (
        <Card>
          <CardBody>
            <EmptyState
              title={summary.disabledReason ? "Проверки выключены" : "Всё заполнено"}
              description={
                summary.disabledReason
                  ? "Задайте FINANCE_PRIMARY_SHARE_START_DATE, чтобы система начала проверять заказы с этой даты."
                  : "Открытых проблем нет. Если данные изменятся, очередь наполнится сама при следующем прогоне детектора."
              }
            />
          </CardBody>
        </Card>
      ) : (
        GROUP_ORDER.filter((g) => byGroup.get(g)?.length).map((group) => (
          <section key={group} className="space-y-2">
            <h2 className="text-sm font-medium text-slate-500">
              {groupTitles[group]} · {byGroup.get(group)!.length}
            </h2>
            <Card>
              <CardBody className="p-0">
                <IssueList issues={byGroup.get(group)!} />
              </CardBody>
            </Card>
          </section>
        ))
      )}
    </div>
  );
}
