import Link from "next/link";
import { prisma } from "@/lib/db";
import { Card, CardBody } from "@/components/ui/Card";
import { Button } from "@/components/ui/button";
import { getSmsTrigger } from "@/modules/automations/triggers";
import { audienceLabel, delayLabel } from "@/modules/automations/display";
import { getAutomationSettings } from "@/modules/automations/settings";
import { AutomationRowActions } from "./AutomationRowActions";
import { SiteReviewUrlPanel } from "./SiteReviewUrlPanel";
import { KillSwitchToggle } from "./KillSwitchToggle";

export const dynamic = "force-dynamic";

export default async function AutomationsPage() {
  const [automations, statRows, lastRuns, sites, settings] = await Promise.all([
    prisma.automation.findMany({
      where: { deletedAt: null },
      include: { sites: { select: { site: { select: { name: true } } }, orderBy: { createdAt: "asc" } } },
      orderBy: [{ createdAt: "desc" }],
    }),
    prisma.automationJob.groupBy({ by: ["automationId", "status"], _count: { _all: true } }),
    prisma.automationJob.groupBy({ by: ["automationId"], _max: { sentAt: true } }),
    prisma.site.findMany({ select: { id: true, name: true, reviewUrl: true, quoEnabled: true, automationDailyLocalTime: true }, orderBy: { name: "asc" } }),
    getAutomationSettings(prisma),
  ]);

  // Метрики по каждому правилу из групп статусов.
  const stats = new Map<string, { sent: number; failed: number; skipped: number; cancelled: number; scheduled: number }>();
  const bump = (id: string) => stats.get(id) ?? stats.set(id, { sent: 0, failed: 0, skipped: 0, cancelled: 0, scheduled: 0 }).get(id)!;
  for (const r of statRows) {
    const s = bump(r.automationId);
    if (r.status === "SENT") s.sent += r._count._all;
    else if (r.status === "FAILED") s.failed += r._count._all;
    else if (r.status === "SKIPPED") s.skipped += r._count._all;
    else if (r.status === "CANCELLED") s.cancelled += r._count._all;
    else if (r.status === "SCHEDULED" || r.status === "PROCESSING") s.scheduled += r._count._all;
  }
  const lastRunByAuto = new Map<string, Date | null>();
  for (const r of lastRuns) lastRunByAuto.set(r.automationId, r._max.sentAt);

  const successRate = (s?: { sent: number; failed: number }) => {
    if (!s) return "—";
    const denom = s.sent + s.failed;
    if (denom === 0) return "—";
    return `${Math.round((s.sent / denom) * 100)}%`;
  };

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-slate-800">Автоматизации</h1>
          <p className="text-sm text-slate-500">Правила автоматических уведомлений по событиям заказа. Канал: SMS (позже — Email/Push/…). Новые правила создаются выключенными.</p>
        </div>
        <Link href="/dashboard/automations/new">
          <Button size="sm">Создать автоматизацию</Button>
        </Link>
      </div>

      <KillSwitchToggle disableAll={settings.disableAll} updatedAt={settings.updatedAt ? settings.updatedAt.toISOString() : null} />

      <Card>
        <CardBody className="overflow-x-auto p-0">
          <table className="w-full min-w-[1040px] text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs text-slate-500">
              <tr>
                <th className="px-3 py-2">Название</th>
                <th className="px-3 py-2">Магазины</th>
                <th className="px-3 py-2">Канал</th>
                <th className="px-3 py-2">Событие</th>
                <th className="px-3 py-2">Аудитория</th>
                <th className="px-3 py-2">Задержка</th>
                <th className="px-3 py-2">Статус</th>
                <th className="px-3 py-2 text-right">Отпр.</th>
                <th className="px-3 py-2 text-right">Ошиб.</th>
                <th className="px-3 py-2 text-right">Проп.</th>
                <th className="px-3 py-2 text-right">Success</th>
                <th className="px-3 py-2">Последний</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {automations.length === 0 && (
                <tr><td colSpan={13} className="px-3 py-10 text-center text-slate-400">Автоматизаций пока нет</td></tr>
              )}
              {automations.map((a) => {
                const trigger = getSmsTrigger(a.triggerType);
                const lastRun = lastRunByAuto.get(a.id) ?? null;
                const s = stats.get(a.id);
                return (
                  <tr key={a.id} className="border-b border-slate-100 last:border-0">
                    <td className="px-3 py-2">
                      <Link href={`/dashboard/automations/${a.id}`} className="font-medium text-slate-800 hover:underline">{a.name}</Link>
                    </td>
                    <td className="px-3 py-2 text-slate-600">
                      {/* Одна карточка на правило: сводка + раскрытие полного списка магазинов. */}
                      {a.sites.length === 0 ? (
                        <span className="text-amber-600">Магазины не выбраны</span>
                      ) : (
                        <details className="group">
                          <summary className="cursor-pointer list-none whitespace-nowrap text-slate-700 hover:underline">
                            {a.sites.length === sites.length ? `Все магазины (${sites.length})` : `Магазинов: ${a.sites.length}`}
                            <span className="ml-1 text-slate-400 group-open:hidden">▾</span>
                            <span className="ml-1 hidden text-slate-400 group-open:inline">▴</span>
                          </summary>
                          <ul className="mt-1 space-y-0.5 text-[11px] text-slate-500">
                            {a.sites.map((s) => <li key={s.site.name}>{s.site.name}</li>)}
                          </ul>
                        </details>
                      )}
                    </td>
                    <td className="px-3 py-2 text-slate-600">{a.channel}</td>
                    <td className="px-3 py-2">
                      {trigger ? (
                        <span className="text-slate-700">{trigger.label}</span>
                      ) : (
                        <span className="rounded border border-amber-200 bg-amber-50 px-1.5 py-px text-[11px] text-amber-700">Unsupported: {a.triggerType}</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-slate-600">{audienceLabel(a.audience)}</td>
                    <td className="px-3 py-2 text-slate-600">{delayLabel(a.delayAmount, a.delayUnit)}</td>
                    <td className="px-3 py-2">
                      {a.active ? (
                        <span className="rounded border border-emerald-200 bg-emerald-50 px-1.5 py-px text-[11px] font-medium text-emerald-700">Active</span>
                      ) : (
                        <span className="rounded border border-slate-200 bg-slate-50 px-1.5 py-px text-[11px] font-medium text-slate-500">Disabled</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-700">{s?.sent ?? 0}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-700">{s?.failed ?? 0}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-500">{s?.skipped ?? 0}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-700">{successRate(s)}</td>
                    <td className="px-3 py-2 text-slate-500">{lastRun ? new Date(lastRun).toLocaleString("ru-RU") : "—"}</td>
                    <td className="px-3 py-2">
                      <AutomationRowActions id={a.id} active={a.active} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </CardBody>
      </Card>

      <SiteReviewUrlPanel sites={sites} />
    </div>
  );
}
