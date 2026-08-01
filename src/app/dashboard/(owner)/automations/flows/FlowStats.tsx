import { prisma } from "@/lib/db";
import { StatTiles, type StatTile } from "../StatTiles";

/**
 * Сводка по цепочкам: запуски + отправки шагов. Без flowId — по всем цепочкам, с flowId — по одной.
 * Считается по AutomationFlowRunStep, то есть только по нашим отправкам через API: у отправленного
 * шага есть sendKey и связь с OrderCommunication. Переписка сотрудников из QUO сюда не попадает.
 */
export async function FlowStats({ flowId }: { flowId?: string }) {
  const [runRows, stepRows] = await Promise.all([
    prisma.automationFlowRun.groupBy({
      by: ["status"],
      where: flowId ? { flowId } : {},
      _count: { _all: true },
    }),
    prisma.automationFlowRunStep.groupBy({
      by: ["channel", "status"],
      where: flowId ? { run: { flowId } } : {},
      _count: { _all: true },
    }),
  ]);

  const runs = { active: 0, completed: 0, cancelled: 0 };
  for (const r of runRows) {
    if (r.status === "ACTIVE") runs.active += r._count._all;
    else if (r.status === "COMPLETED") runs.completed += r._count._all;
    else runs.cancelled += r._count._all;
  }

  const byChannel = {
    SMS: { sent: 0, failed: 0, skipped: 0, scheduled: 0 },
    EMAIL: { sent: 0, failed: 0, skipped: 0, scheduled: 0 },
  };
  for (const r of stepRows) {
    // Шаги WAIT (channel = null) — не отправка, в счётчики каналов не идут.
    if (r.channel !== "SMS" && r.channel !== "EMAIL") continue;
    const t = byChannel[r.channel];
    if (r.status === "SENT") t.sent += r._count._all;
    else if (r.status === "FAILED") t.failed += r._count._all;
    else if (r.status === "SKIPPED") t.skipped += r._count._all;
    else if (r.status === "SCHEDULED" || r.status === "PROCESSING") t.scheduled += r._count._all;
  }

  const channelTiles = (t: { sent: number; failed: number; skipped: number; scheduled: number }, prefix: string): StatTile[] => [
    { key: `${prefix}-sent`, label: "Отправлено", value: t.sent, accent: "text-emerald-700" },
    { key: `${prefix}-failed`, label: "Не прошло отправку", value: t.failed, accent: "text-red-700" },
    { key: `${prefix}-skipped`, label: "Пропущено по условиям", value: t.skipped, accent: "text-slate-600" },
    { key: `${prefix}-queued`, label: "В очереди", value: t.scheduled, accent: "text-sky-700" },
  ];

  return (
    <div className="space-y-3">
      <StatTiles
        caption="Запуски цепочек"
        tiles={[
          { key: "run-active", label: "Активные", value: runs.active, accent: "text-sky-700" },
          { key: "run-done", label: "Завершены", value: runs.completed, accent: "text-emerald-700" },
          { key: "run-cancelled", label: "Отменены", value: runs.cancelled, accent: "text-amber-700" },
        ]}
      />
      <StatTiles caption="SMS через API" tiles={channelTiles(byChannel.SMS, "sms")} />
      <StatTiles caption="Email через API" tiles={channelTiles(byChannel.EMAIL, "email")} />
      <p className="text-[11px] text-slate-400">
        Только шаги цепочек. Переписка сотрудников из QUO и одиночные правила сюда не входят.
      </p>
    </div>
  );
}
