import Link from "next/link";
import { prisma } from "@/lib/db";
import { Card, CardBody } from "@/components/ui/Card";
import { Button } from "@/components/ui/button";
import { getSmsTrigger } from "@/modules/sms/triggers";
import { audienceLabel, delayLabel } from "@/modules/sms/display";
import { AutomationRowActions } from "./AutomationRowActions";
import { SiteReviewUrlPanel } from "./SiteReviewUrlPanel";

export const dynamic = "force-dynamic";

export default async function SmsMarketingPage() {
  const [automations, statRows, lastRuns, sites] = await Promise.all([
    prisma.smsAutomation.findMany({
      where: { deletedAt: null },
      include: { site: { select: { name: true } } },
      orderBy: [{ createdAt: "desc" }],
    }),
    prisma.smsAutomationJob.groupBy({ by: ["automationId", "status"], _count: { _all: true } }),
    prisma.smsAutomationJob.groupBy({ by: ["automationId"], _max: { sentAt: true } }),
    prisma.site.findMany({ select: { id: true, name: true, reviewUrl: true, quoEnabled: true }, orderBy: { name: "asc" } }),
  ]);

  const sentByAuto = new Map<string, number>();
  const errByAuto = new Map<string, number>();
  for (const r of statRows) {
    if (r.status === "SENT") sentByAuto.set(r.automationId, r._count._all);
    if (r.status === "FAILED") errByAuto.set(r.automationId, (errByAuto.get(r.automationId) ?? 0) + r._count._all);
  }
  const lastRunByAuto = new Map<string, Date | null>();
  for (const r of lastRuns) lastRunByAuto.set(r.automationId, r._max.sentAt);

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-slate-800">SMS-маркетинг</h1>
          <p className="text-sm text-slate-500">Автоматические SMS по событиям заказа. Новые правила создаются выключенными.</p>
        </div>
        <Link href="/dashboard/sms-marketing/new">
          <Button size="sm">Создать автоматизацию</Button>
        </Link>
      </div>

      <Card>
        <CardBody className="overflow-x-auto p-0">
          <table className="w-full min-w-[900px] text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs text-slate-500">
              <tr>
                <th className="px-3 py-2">Название</th>
                <th className="px-3 py-2">Магазин</th>
                <th className="px-3 py-2">Событие</th>
                <th className="px-3 py-2">Аудитория</th>
                <th className="px-3 py-2">Задержка</th>
                <th className="px-3 py-2">Статус</th>
                <th className="px-3 py-2 text-right">Отправлено</th>
                <th className="px-3 py-2 text-right">Ошибок</th>
                <th className="px-3 py-2">Последний запуск</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {automations.length === 0 && (
                <tr><td colSpan={10} className="px-3 py-10 text-center text-slate-400">Автоматизаций пока нет</td></tr>
              )}
              {automations.map((a) => {
                const trigger = getSmsTrigger(a.triggerType);
                const lastRun = lastRunByAuto.get(a.id) ?? null;
                return (
                  <tr key={a.id} className="border-b border-slate-100 last:border-0">
                    <td className="px-3 py-2">
                      <Link href={`/dashboard/sms-marketing/${a.id}`} className="font-medium text-slate-800 hover:underline">{a.name}</Link>
                    </td>
                    <td className="px-3 py-2 text-slate-600">{a.site.name}</td>
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
                    <td className="px-3 py-2 text-right tabular-nums text-slate-700">{sentByAuto.get(a.id) ?? 0}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-700">{errByAuto.get(a.id) ?? 0}</td>
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
