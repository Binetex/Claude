import Link from "next/link";
import { prisma } from "@/lib/db";
import { Card, CardBody } from "@/components/ui/Card";
import { Button } from "@/components/ui/button";
import { getSmsTrigger } from "@/modules/automations/triggers";
import { flowStepSummary, FLOW_STEP_TYPE_LABELS } from "@/modules/automations/flows/display";
import { AutomationsTabs } from "../AutomationsTabs";
import { FlowRowActions } from "./FlowRowActions";

export const dynamic = "force-dynamic";

export default async function FlowsPage() {
  const [flows, runStats] = await Promise.all([
    prisma.automationFlow.findMany({
      where: { deletedAt: null },
      include: {
        sites: { select: { site: { select: { name: true } } }, orderBy: { createdAt: "asc" } },
        steps: { where: { deletedAt: null }, orderBy: { position: "asc" } },
      },
      orderBy: [{ createdAt: "desc" }],
    }),
    prisma.automationFlowRun.groupBy({ by: ["flowId", "status"], _count: { _all: true } }),
  ]);

  const stats = new Map<string, { active: number; completed: number; cancelled: number }>();
  for (const r of runStats) {
    const s = stats.get(r.flowId) ?? { active: 0, completed: 0, cancelled: 0 };
    if (r.status === "ACTIVE") s.active += r._count._all;
    else if (r.status === "COMPLETED") s.completed += r._count._all;
    else s.cancelled += r._count._all;
    stats.set(r.flowId, s);
  }

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <div>
        <h1 className="text-xl font-bold text-slate-800">Автоматизации</h1>
        <p className="text-sm text-slate-500">
          Marketing Flows — цепочки шагов по событию заказа. На каждый заказ создаётся отдельный запуск.
        </p>
      </div>

      <AutomationsTabs />

      <div className="flex items-center justify-between">
        <p className="text-sm text-slate-500">Шаги выполняются последовательно: ожидание, письмо или SMS.</p>
        <Link href="/dashboard/automations/flows/new">
          <Button size="sm">Создать цепочку</Button>
        </Link>
      </div>

      <Card>
        <CardBody className="overflow-x-auto p-0">
          <table className="w-full min-w-[900px] text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs text-slate-500">
              <tr>
                <th className="px-3 py-2">Название</th>
                <th className="px-3 py-2">Магазины</th>
                <th className="px-3 py-2">Событие</th>
                <th className="px-3 py-2">Шаги</th>
                <th className="px-3 py-2">Статус</th>
                <th className="px-3 py-2 text-right">Активных</th>
                <th className="px-3 py-2 text-right">Завершено</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {flows.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-3 py-10 text-center text-slate-400">
                    Цепочек пока нет
                  </td>
                </tr>
              )}
              {flows.map((f) => {
                const trigger = getSmsTrigger(f.triggerType);
                const s = stats.get(f.id);
                return (
                  <tr key={f.id} className="border-b border-slate-100 last:border-0 align-top">
                    <td className="px-3 py-2">
                      <Link href={`/dashboard/automations/flows/${f.id}`} className="font-medium text-slate-800 hover:underline">
                        {f.name}
                      </Link>
                    </td>
                    <td className="px-3 py-2 text-slate-600">
                      {f.sites.length === 0 ? (
                        <span className="text-amber-600">Магазины не выбраны</span>
                      ) : (
                        <details className="group">
                          <summary className="cursor-pointer list-none whitespace-nowrap text-slate-700 hover:underline">
                            Магазинов: {f.sites.length}
                            <span className="ml-1 text-slate-400 group-open:hidden">▾</span>
                            <span className="ml-1 hidden text-slate-400 group-open:inline">▴</span>
                          </summary>
                          <ul className="mt-1 space-y-0.5 text-[11px] text-slate-500">
                            {f.sites.map((x) => (
                              <li key={x.site.name}>{x.site.name}</li>
                            ))}
                          </ul>
                        </details>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {trigger ? (
                        <span className="text-slate-700">{trigger.label}</span>
                      ) : (
                        <span className="rounded border border-amber-200 bg-amber-50 px-1.5 py-px text-[11px] text-amber-700">
                          Unsupported: {f.triggerType}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {f.steps.length === 0 ? (
                        <span className="text-amber-600">Нет шагов</span>
                      ) : (
                        <ol className="space-y-0.5 text-[11px] text-slate-600">
                          {f.steps.map((st, i) => (
                            <li key={st.id}>
                              <span className="text-slate-400">{i + 1}.</span> {FLOW_STEP_TYPE_LABELS[st.type]} — {flowStepSummary(st)}
                            </li>
                          ))}
                        </ol>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {f.active ? (
                        <span className="rounded border border-emerald-200 bg-emerald-50 px-1.5 py-px text-[11px] font-medium text-emerald-700">Active</span>
                      ) : (
                        <span className="rounded border border-slate-200 bg-slate-50 px-1.5 py-px text-[11px] font-medium text-slate-500">Disabled</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-700">{s?.active ?? 0}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-700">{s?.completed ?? 0}</td>
                    <td className="px-3 py-2">
                      <FlowRowActions id={f.id} active={f.active} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </CardBody>
      </Card>
    </div>
  );
}
