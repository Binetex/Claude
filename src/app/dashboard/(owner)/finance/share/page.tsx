import Link from "next/link";
import { requireRole } from "@/lib/rbac";
import { PageHeader, StatCard } from "@/components/ui/misc";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/states";
import { formatCents } from "@/lib/cents";
import { listShareDaysRead, PER_PAGE_OPTIONS, type ShareDayStatus } from "@/modules/finance/shareRead";
import { SharePercentForm, RecomputeShareButton } from "./ShareControls";
import { PerPageSelect } from "./PerPageSelect";

export const dynamic = "force-dynamic";

/**
 * Доля основного флориста — список дней.
 *
 * Страница ЧИТАЕТ опубликованный расчёт и книгу: шесть запросов независимо от того,
 * 20 дней на экране или 100. Живого пересчёта здесь нет — он остался на пути записи.
 * Раньше страница строила план каждого дня по четыре раза и на длинной истории просто
 * не открывалась бы.
 */
const statusMeta: Record<ShareDayStatus, { label: string; className: string }> = {
  COUNTED: { label: "посчитан", className: "border-emerald-200 bg-emerald-50 text-emerald-700" },
  INCOMPLETE: { label: "не все заказы заполнены", className: "border-amber-200 bg-amber-50 text-amber-800" },
  NOT_CALCULATED: { label: "не рассчитан", className: "border-slate-200 bg-slate-50 text-slate-400" },
};

export default async function PrimarySharePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requireRole("OWNER");
  const sp = await searchParams;
  const page = Math.max(Number(sp.page ?? 1) || 1, 1);
  const perPage = Number(sp.perPage ?? PER_PAGE_OPTIONS[0]) || PER_PAGE_OPTIONS[0];

  const data = await listShareDaysRead({ page, perPage });
  const totalPages = Math.max(Math.ceil(data.totalDays / data.perPage), 1);

  const counted = data.rows.filter((r) => r.status === "COUNTED").length;
  const attention = data.rows.filter((r) => r.status !== "COUNTED").length;

  const href = (p: number, pp: number = data.perPage) => `/dashboard/finance/share?page=${p}&perPage=${pp}`;

  return (
    <div className="space-y-4">
      <PageHeader
        title={`Доля основного флориста${data.floristName ? ` · ${data.floristName}` : ""}`}
        description="Показан опубликованный расчёт. Начисление отражает рассчитанный долг и денег не переводит — выплата появляется только вручную операцией «Выплата»."
        actions={data.profileId && data.sharePercentBp != null ? <RecomputeShareButton /> : undefined}
      />

      {data.disabledReason ? (
        <Card>
          <CardBody className="text-sm text-slate-600">
            <div className="font-medium text-slate-800">Расчёт не запущен</div>
            <div className="mt-1 text-slate-500">{data.disabledReason}</div>
          </CardBody>
        </Card>
      ) : data.sharePercentBp == null ? (
        <Card>
          <CardBody className="space-y-3">
            <div>
              <div className="font-medium text-slate-800">Доля не задана</div>
              <div className="mt-1 text-sm text-slate-500">
                Пока процент не задан, начисления не создаются: подставлять значение «по умолчанию» нельзя — это деньги.
              </div>
            </div>
            {data.floristId && <SharePercentForm floristId={data.floristId} defaultDate={data.startDate} />}
          </CardBody>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard label="Доля" value={`${(data.sharePercentBp / 100).toFixed(2)}%`} />
            <StatCard label="Доля за дни страницы" value={formatCents(data.pageShareCents)} tone="success" />
            <StatCard label="Дней посчитано" value={counted} tone="default" />
            <StatCard label="Дней требуют внимания" value={attention} tone={attention > 0 ? "warning" : "default"} />
          </div>

          {data.startDate && (
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-400">
              <span>
                Считаются заказы с {data.startDate.toISOString().slice(0, 10)}. Более ранние — исторические. Всего дней:{" "}
                {data.totalDays}.
              </span>
              {data.floristId && <SharePercentForm floristId={data.floristId} defaultDate={data.startDate} compact />}
            </div>
          )}
        </>
      )}

      {data.rows.length === 0 ? (
        !data.disabledReason && (
          <Card>
            <CardBody>
              <EmptyState title="Доставленных заказов с даты запуска пока нет" />
            </CardBody>
          </Card>
        )
      ) : (
        <Card>
          <CardHeader className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle>
              Дни {(data.page - 1) * data.perPage + 1}–{Math.min(data.page * data.perPage, data.totalDays)} из{" "}
              {data.totalDays}
            </CardTitle>
            <PerPageSelect current={data.perPage} />
          </CardHeader>
          <CardBody className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-100 text-left text-[11px] tracking-wide text-slate-400 uppercase">
                    <th className="px-4 py-2.5 font-medium">День</th>
                    <th className="px-3 py-2.5 font-medium">Статус</th>
                    <th className="px-3 py-2.5 text-right font-medium">Заказов</th>
                    <th className="px-3 py-2.5 text-right font-medium">Прибыль</th>
                    <th className="px-4 py-2.5 text-right font-medium">Доля флориста</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((r) => (
                    <tr key={r.day} className="border-b border-slate-50 last:border-0 hover:bg-slate-50/60">
                      <td className="px-4 py-2.5 tabular-nums">
                        <Link href={`/dashboard/finance/share/${r.day}`} className="font-medium text-slate-800 hover:underline">
                          {r.day}
                        </Link>
                      </td>
                      <td className="px-3 py-2.5">
                        <Badge className={statusMeta[r.status].className}>{statusMeta[r.status].label}</Badge>
                        {r.openIssues > 0 && (
                          <Link
                            href="/dashboard/finance/setup"
                            className="ml-2 text-xs text-blue-600 hover:underline"
                          >
                            проблем: {r.openIssues}
                          </Link>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-slate-600">{r.ordersTotal}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-slate-600">
                        {r.status === "NOT_CALCULATED" ? (
                          <span className="text-slate-300">—</span>
                        ) : (
                          formatCents(r.distributableCents)
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-right font-semibold tabular-nums">
                        {r.status === "COUNTED" ? (
                          <span className="text-emerald-700">{formatCents(r.shareCents)}</span>
                        ) : (
                          <span className="text-slate-300">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardBody>
          {totalPages > 1 && (
            <div className="flex items-center justify-between border-t border-slate-100 px-4 py-3 text-sm">
              <span className="text-slate-500">
                Страница {data.page} из {totalPages}
              </span>
              <div className="flex gap-2">
                <Button asChild variant="outline" size="sm" disabled={data.page <= 1}>
                  <Link href={href(data.page - 1)}>Назад</Link>
                </Button>
                <Button asChild variant="outline" size="sm" disabled={data.page >= totalPages}>
                  <Link href={href(data.page + 1)}>Вперёд</Link>
                </Button>
              </div>
            </div>
          )}
        </Card>
      )}

      <p className="text-xs text-slate-400">
        День считается целиком или не считается: пока по какому-то заказу не хватает данных, доли за этот день нет.
        Долг флориста складывается из долей посчитанных дней — отдельных начислений в книге больше нет.
      </p>
    </div>
  );
}
