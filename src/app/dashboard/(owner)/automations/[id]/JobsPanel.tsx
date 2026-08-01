import Link from "next/link";
import { prisma } from "@/lib/db";
import { Card, CardBody } from "@/components/ui/Card";
import { buttonVariants } from "@/components/ui/button";
import type { SmsJobStatus } from "@/generated/prisma/enums";
import {
  audienceLabel,
  jobStatusLabel,
  jobStatusClass,
  maskPhoneDisplay,
  maskEmailDisplay,
  channelLabel,
} from "@/modules/automations/display";

/**
 * Вкладка «Статистика» конкретного правила: сводка по статусам + история задач страницами.
 * Лента внутренних этапов (scheduled/picked/rendered/...) владельцу по умолчанию не показывается —
 * она спрятана под «Технические детали» внутри своей задачи. Общей ленты всех событий больше нет.
 */

export const JOBS_PER_PAGE = 10;

type FilterKey = "all" | "sent" | "failed" | "skipped" | "cancelled" | "pending";

// Владельцу нужны не сырые статусы, а ответ на вопрос «что не ушло» — поэтому фильтры,
// а не просто колонка со статусом.
const FILTERS: { key: FilterKey; label: string; statuses: SmsJobStatus[] | null; accent: string }[] = [
  { key: "all", label: "Всего задач", statuses: null, accent: "text-slate-800" },
  { key: "sent", label: "Отправлено", statuses: ["SENT"], accent: "text-emerald-700" },
  { key: "failed", label: "Ошибки", statuses: ["FAILED"], accent: "text-red-700" },
  { key: "skipped", label: "Пропущено", statuses: ["SKIPPED"], accent: "text-slate-600" },
  { key: "cancelled", label: "Отменено", statuses: ["CANCELLED"], accent: "text-amber-700" },
  { key: "pending", label: "В очереди", statuses: ["SCHEDULED", "PROCESSING"], accent: "text-sky-700" },
];

export function parseFilter(raw: string | undefined): FilterKey {
  return FILTERS.some((f) => f.key === raw) ? (raw as FilterKey) : "all";
}

export function parsePage(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 1 ? Math.floor(n) : 1;
}

function buildHref(automationId: string, filter: FilterKey, page: number): string {
  const p = new URLSearchParams({ tab: "stats" });
  if (filter !== "all") p.set("status", filter);
  if (page > 1) p.set("page", String(page));
  return `/dashboard/automations/${automationId}?${p.toString()}`;
}

const fmt = (d: Date | null | undefined) => (d ? new Date(d).toLocaleString("ru-RU") : "—");

export async function JobsPanel({
  automationId,
  filter,
  page,
}: {
  automationId: string;
  filter: FilterKey;
  page: number;
}) {
  const active = FILTERS.find((f) => f.key === filter) ?? FILTERS[0];
  const where = {
    automationId,
    ...(active.statuses ? { status: { in: active.statuses } } : {}),
  };

  const [statRows, total] = await Promise.all([
    prisma.automationJob.groupBy({ by: ["status"], where: { automationId }, _count: { _all: true } }),
    prisma.automationJob.count({ where }),
  ]);

  const lastPage = Math.max(1, Math.ceil(total / JOBS_PER_PAGE));
  // Страница из старой ссылки может уехать за конец выборки — показываем последнюю, а не пустоту.
  const safePage = Math.min(page, lastPage);

  const jobs = await prisma.automationJob.findMany({
    where,
    include: { order: { select: { orderNumber: true } } },
    orderBy: { createdAt: "desc" },
    skip: (safePage - 1) * JOBS_PER_PAGE,
    take: JOBS_PER_PAGE,
  });

  // Технические этапы тянем только для задач текущей страницы: длинной общей ленты больше нет.
  const logs = jobs.length
    ? await prisma.automationExecutionLog.findMany({
        where: { jobId: { in: jobs.map((j) => j.id) } },
        orderBy: { createdAt: "asc" },
        select: { id: true, jobId: true, stage: true, detailSafe: true, createdAt: true },
      })
    : [];
  const logsByJob = new Map<string, typeof logs>();
  for (const l of logs) {
    const list = logsByJob.get(l.jobId) ?? [];
    list.push(l);
    logsByJob.set(l.jobId, list);
  }

  const countOf = (statuses: SmsJobStatus[] | null) =>
    statRows
      .filter((r) => !statuses || statuses.includes(r.status))
      .reduce((sum, r) => sum + r._count._all, 0);

  const from = total === 0 ? 0 : (safePage - 1) * JOBS_PER_PAGE + 1;
  const to = Math.min(safePage * JOBS_PER_PAGE, total);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        {FILTERS.map((f) => {
          const isActive = f.key === filter;
          return (
            <Link
              key={f.key}
              href={buildHref(automationId, f.key, 1)}
              className={
                isActive
                  ? "rounded-xl border border-slate-800 bg-white px-3 py-2 shadow-sm"
                  : "rounded-xl border border-slate-200 bg-white px-3 py-2 shadow-sm hover:border-slate-300 hover:bg-slate-50"
              }
            >
              <div className={`text-lg font-semibold tabular-nums ${f.accent}`}>{countOf(f.statuses)}</div>
              <div className="text-[11px] text-slate-500">{f.label}</div>
            </Link>
          );
        })}
      </div>

      <Card>
        <CardBody className="space-y-2 p-0">
          <div className="flex flex-wrap items-center justify-between gap-2 px-4 pt-3">
            <div>
              <h2 className="text-sm font-semibold text-slate-800">
                История задач
                {filter !== "all" && <span className="ml-2 text-xs font-normal text-slate-500">фильтр: {active.label}</span>}
              </h2>
              <p className="text-xs text-slate-500">Телефоны и email маскированы. Полный payload/секреты не показываем.</p>
            </div>
            {filter !== "all" && (
              <Link href={buildHref(automationId, "all", 1)} className="text-xs text-sky-600 hover:underline">
                Сбросить фильтр
              </Link>
            )}
          </div>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead className="border-y border-slate-200 bg-slate-50 text-left text-xs text-slate-500">
                <tr>
                  <th className="px-3 py-2">Заказ</th>
                  <th className="px-3 py-2">Канал</th>
                  <th className="px-3 py-2">Адресат</th>
                  <th className="px-3 py-2">Контакт</th>
                  <th className="px-3 py-2">Запланировано</th>
                  <th className="px-3 py-2">Статус</th>
                  <th className="px-3 py-2">Отправлено</th>
                  <th className="px-3 py-2">Причина</th>
                </tr>
              </thead>
              <tbody>
                {jobs.length === 0 && (
                  <tr>
                    <td colSpan={8} className="px-3 py-8 text-center text-slate-400">
                      {filter === "all" ? "Задач ещё нет" : "По этому фильтру задач нет"}
                    </td>
                  </tr>
                )}
                {jobs.map((j) => {
                  const jobLogs = logsByJob.get(j.id) ?? [];
                  return (
                    <tr key={j.id} className="border-b border-slate-100 align-top last:border-0">
                      <td className="px-3 py-2 text-slate-700">{j.order?.orderNumber ?? "—"}</td>
                      <td className="px-3 py-2 text-slate-600">{channelLabel(j.channel)}</td>
                      <td className="px-3 py-2 text-slate-600">{audienceLabel(j.recipientType)}</td>
                      <td className="px-3 py-2 font-mono text-slate-600">
                        {j.channel === "EMAIL" ? maskEmailDisplay(j.emailNormalized) : maskPhoneDisplay(j.phoneNormalized)}
                      </td>
                      <td className="px-3 py-2 text-slate-500">{fmt(j.scheduledAt)}</td>
                      <td className="px-3 py-2">
                        <span className={`rounded border px-1.5 py-px text-[11px] font-medium ${jobStatusClass(j.status)}`}>
                          {jobStatusLabel(j.status)}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-slate-500">{fmt(j.sentAt)}</td>
                      <td className="px-3 py-2 text-slate-500">
                        <div>{j.lastErrorSafe ?? "—"}</div>
                        {jobLogs.length > 0 && (
                          // Диагностика по требованию: закрыто по умолчанию, в пределах своей задачи.
                          <details className="mt-1">
                            <summary className="cursor-pointer list-none text-[11px] text-slate-400 hover:text-slate-600">
                              Технические детали ({jobLogs.length})
                            </summary>
                            <ul className="mt-1 space-y-0.5 border-l border-slate-200 pl-2 text-[11px] text-slate-500">
                              {jobLogs.map((l) => (
                                <li key={l.id}>
                                  <span className="text-slate-400">{fmt(l.createdAt)}</span> · <span className="text-slate-700">{l.stage}</span>
                                  {l.detailSafe ? ` · ${l.detailSafe}` : ""}
                                </li>
                              ))}
                            </ul>
                          </details>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 px-4 pb-3">
            <span className="text-xs text-slate-500 tabular-nums">
              {total === 0 ? "Ничего не найдено" : `${from}–${to} из ${total}`}
            </span>
            {lastPage > 1 && (
              <div className="flex items-center gap-1">
                <Link
                  href={buildHref(automationId, filter, safePage - 1)}
                  aria-disabled={safePage <= 1}
                  className={`${buttonVariants({ size: "sm", variant: "outline" })} ${safePage <= 1 ? "pointer-events-none opacity-50" : ""}`}
                >
                  Назад
                </Link>
                <span className="px-1 text-xs text-slate-500 tabular-nums">
                  {safePage} / {lastPage}
                </span>
                <Link
                  href={buildHref(automationId, filter, safePage + 1)}
                  aria-disabled={safePage >= lastPage}
                  className={`${buttonVariants({ size: "sm", variant: "outline" })} ${safePage >= lastPage ? "pointer-events-none opacity-50" : ""}`}
                >
                  Вперёд
                </Link>
              </div>
            )}
          </div>
        </CardBody>
      </Card>
    </div>
  );
}
