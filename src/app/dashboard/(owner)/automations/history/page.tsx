import Link from "next/link";
import { prisma } from "@/lib/db";
import { Card, CardBody } from "@/components/ui/Card";
import {
  FLOW_RUN_STATUS_LABELS,
  FLOW_STEP_STATUS_LABELS,
  FLOW_CANCEL_REASON_LABELS,
  FLOW_STEP_TYPE_LABELS,
} from "@/modules/automations/flows/display";
import { AutomationsTabs } from "../AutomationsTabs";
import { FlowStats } from "../flows/FlowStats";

export const dynamic = "force-dynamic";

const fmt = (d: Date | null | undefined) => (d ? new Date(d).toLocaleString("ru-RU") : "—");

const STEP_STATUS_CLASS: Record<string, string> = {
  SENT: "border-emerald-200 bg-emerald-50 text-emerald-700",
  FAILED: "border-red-200 bg-red-50 text-red-700",
  SKIPPED: "border-slate-200 bg-slate-50 text-slate-500",
  CANCELLED: "border-slate-200 bg-slate-50 text-slate-500",
  SCHEDULED: "border-sky-200 bg-sky-50 text-sky-700",
  PROCESSING: "border-sky-200 bg-sky-50 text-sky-700",
};

export default async function FlowHistoryPage() {
  const runs = await prisma.automationFlowRun.findMany({
    include: {
      flow: { select: { name: true, triggerType: true } },
      order: { select: { orderNumber: true } },
      site: { select: { name: true } },
      steps: { orderBy: { position: "asc" } },
    },
    orderBy: [{ startedAt: "desc" }],
    take: 50,
  });

  const stepById = new Map<string, { position: number; type: string }>();
  for (const r of runs) for (const s of r.steps) stepById.set(s.stepId, { position: s.position, type: s.type });

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <h1 className="text-xl font-bold text-slate-800">Автоматизации</h1>

      <AutomationsTabs />

      <FlowStats />

      {runs.length === 0 && (
        <Card>
          <CardBody className="py-10 text-center text-sm text-slate-400">Запусков пока не было</CardBody>
        </Card>
      )}

      <div className="space-y-3">
        {runs.map((run) => {
          const current = run.currentStepId ? stepById.get(run.currentStepId) : null;
          return (
            <Card key={run.id}>
              <CardBody className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-slate-800">
                      {run.flow.name}
                      <span className="ml-2 text-xs font-normal text-slate-500">
                        заказ {run.order.orderNumber} · {run.site.name}
                      </span>
                    </p>
                    <p className="text-[11px] text-slate-500">
                      Запущена {fmt(run.startedAt)}
                      {run.finishedAt ? ` · завершена ${fmt(run.finishedAt)}` : ""}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 text-[11px]">
                    <span
                      className={
                        run.status === "ACTIVE"
                          ? "rounded border border-sky-200 bg-sky-50 px-1.5 py-px font-medium text-sky-700"
                          : run.status === "COMPLETED"
                            ? "rounded border border-emerald-200 bg-emerald-50 px-1.5 py-px font-medium text-emerald-700"
                            : "rounded border border-slate-200 bg-slate-50 px-1.5 py-px font-medium text-slate-500"
                      }
                    >
                      {FLOW_RUN_STATUS_LABELS[run.status] ?? run.status}
                    </span>
                    {run.status === "ACTIVE" && (
                      <span className="text-slate-500">
                        шаг {current ? `${current.position} (${FLOW_STEP_TYPE_LABELS[current.type as "WAIT" | "EMAIL" | "SMS"]})` : "—"} ·
                        следующий запуск {fmt(run.nextRunAt)}
                      </span>
                    )}
                    {run.cancelledReason && (
                      <span className="text-slate-500">
                        причина: {FLOW_CANCEL_REASON_LABELS[run.cancelledReason] ?? run.cancelledReason}
                      </span>
                    )}
                  </div>
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full min-w-[760px] text-xs">
                    <thead className="border-b border-slate-200 text-left text-[11px] text-slate-500">
                      <tr>
                        <th className="py-1 pr-3">#</th>
                        <th className="py-1 pr-3">Шаг</th>
                        <th className="py-1 pr-3">Статус</th>
                        <th className="py-1 pr-3">Запланирован</th>
                        <th className="py-1 pr-3">Выполнен</th>
                        <th className="py-1 pr-3 text-right">Попыток</th>
                        <th className="py-1 pr-3">Ошибка / причина</th>
                        <th className="py-1">Провайдер</th>
                      </tr>
                    </thead>
                    <tbody>
                      {run.steps.map((s) => (
                        <tr key={s.id} className="border-b border-slate-100 last:border-0">
                          <td className="py-1 pr-3 text-slate-400">{s.position}</td>
                          <td className="py-1 pr-3 text-slate-700">
                            {FLOW_STEP_TYPE_LABELS[s.type]}
                            {s.channel && s.type !== "WAIT" && <span className="ml-1 text-slate-400">{s.channel}</span>}
                          </td>
                          <td className="py-1 pr-3">
                            <span className={`rounded border px-1.5 py-px ${STEP_STATUS_CLASS[s.status] ?? "border-slate-200 bg-slate-50 text-slate-500"}`}>
                              {FLOW_STEP_STATUS_LABELS[s.status] ?? s.status}
                            </span>
                          </td>
                          <td className="py-1 pr-3 text-slate-500">{fmt(s.scheduledAt)}</td>
                          <td className="py-1 pr-3 text-slate-500">{fmt(s.sentAt ?? s.skippedAt ?? s.failedAt)}</td>
                          <td className="py-1 pr-3 text-right tabular-nums text-slate-600">{s.attempts}</td>
                          <td className="py-1 pr-3 text-slate-500">{s.lastErrorSafe ?? "—"}</td>
                          <td className="py-1 text-slate-500">
                            {s.providerMessageId ? <span className="font-mono text-[10px]">{s.providerMessageId}</span> : "—"}
                            {s.communicationId && (
                              <span className="ml-1 text-[10px] text-slate-400" title={`OrderCommunication ${s.communicationId}`}>
                                (в переписке)
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                      {run.steps.length === 0 && (
                        <tr>
                          <td colSpan={8} className="py-3 text-center text-slate-400">
                            Шаги ещё не запланированы
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </CardBody>
            </Card>
          );
        })}
      </div>

      <p className="text-[11px] text-slate-500">
        История одиночных уведомлений — во вкладке «Статистика» конкретного правила в{" "}
        <Link href="/dashboard/automations" className="text-sky-600 hover:underline">
          Order Notifications
        </Link>
        .
      </p>
    </div>
  );
}
