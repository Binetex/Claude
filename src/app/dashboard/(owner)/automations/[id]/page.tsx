import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { Card, CardBody } from "@/components/ui/Card";
import { listSmsTriggers } from "@/modules/automations/triggers";
import { SMS_VARIABLES } from "@/modules/automations/variables";
import { audienceLabel, jobStatusLabel, jobStatusClass, maskPhoneDisplay } from "@/modules/automations/display";
import { AutomationForm, type AutomationFormInitial } from "../AutomationForm";
import type { SmsConditions } from "@/modules/automations/conditions";

export const dynamic = "force-dynamic";

export default async function EditAutomationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const automation = await prisma.automation.findUnique({ where: { id } });
  if (!automation || automation.deletedAt) notFound();

  const [sites, recentOrders, jobs, execLogs] = await Promise.all([
    prisma.site.findMany({ select: { id: true, name: true, quoEnabled: true }, orderBy: { name: "asc" } }),
    prisma.order.findMany({ select: { id: true, orderNumber: true, siteId: true }, orderBy: { createdAt: "desc" }, take: 50 }),
    prisma.automationJob.findMany({
      where: { automationId: id },
      include: { order: { select: { orderNumber: true } } },
      orderBy: { createdAt: "desc" },
      take: 100,
    }),
    prisma.automationExecutionLog.findMany({
      where: { automationId: id },
      orderBy: { createdAt: "desc" },
      take: 60,
      select: { id: true, jobId: true, stage: true, detailSafe: true, createdAt: true },
    }),
  ]);

  const triggers = listSmsTriggers().map((t) => ({ type: t.type, label: t.label, description: t.description }));
  const variables = SMS_VARIABLES.map((v) => ({ key: v.key, label: v.label, example: v.example }));

  const initial: AutomationFormInitial = {
    id: automation.id,
    siteId: automation.siteId,
    name: automation.name,
    active: automation.active,
    channel: automation.channel,
    triggerType: automation.triggerType,
    audience: automation.audience,
    delayAmount: automation.delayAmount,
    delayUnit: automation.delayUnit,
    template: automation.template,
    conditions: (automation.conditionsJson as SmsConditions | null) ?? { excludeCancelledRefunded: true },
  };

  return (
    <div className="space-y-4">
      <AutomationForm initial={initial} sites={sites} recentOrders={recentOrders} triggers={triggers} variables={variables} />

      <div className="mx-auto max-w-3xl">
        <Card>
          <CardBody className="space-y-2 p-0">
            <div className="px-4 pt-3">
              <h2 className="text-sm font-semibold text-slate-800">История задач</h2>
              <p className="text-xs text-slate-500">Телефоны маскированы. Полный payload/секреты не показываем.</p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-sm">
                <thead className="border-y border-slate-200 bg-slate-50 text-left text-xs text-slate-500">
                  <tr>
                    <th className="px-3 py-2">Заказ</th>
                    <th className="px-3 py-2">Адресат</th>
                    <th className="px-3 py-2">Телефон</th>
                    <th className="px-3 py-2">Запланировано</th>
                    <th className="px-3 py-2">Статус</th>
                    <th className="px-3 py-2">Отправлено</th>
                    <th className="px-3 py-2">Причина</th>
                  </tr>
                </thead>
                <tbody>
                  {jobs.length === 0 && <tr><td colSpan={7} className="px-3 py-8 text-center text-slate-400">Задач ещё нет</td></tr>}
                  {jobs.map((j) => (
                    <tr key={j.id} className="border-b border-slate-100 last:border-0">
                      <td className="px-3 py-2 text-slate-700">{j.order?.orderNumber ?? "—"}</td>
                      <td className="px-3 py-2 text-slate-600">{audienceLabel(j.recipientType)}</td>
                      <td className="px-3 py-2 font-mono text-slate-600">{maskPhoneDisplay(j.phoneNormalized)}</td>
                      <td className="px-3 py-2 text-slate-500">{new Date(j.scheduledAt).toLocaleString("ru-RU")}</td>
                      <td className="px-3 py-2">
                        <span className={`rounded border px-1.5 py-px text-[11px] font-medium ${jobStatusClass(j.status)}`}>{jobStatusLabel(j.status)}</span>
                      </td>
                      <td className="px-3 py-2 text-slate-500">{j.sentAt ? new Date(j.sentAt).toLocaleString("ru-RU") : "—"}</td>
                      <td className="px-3 py-2 text-slate-500">{j.lastErrorSafe ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardBody>
        </Card>

        <Card className="mt-4">
          <CardBody className="space-y-2 p-0">
            <div className="px-4 pt-3">
              <h2 className="text-sm font-semibold text-slate-800">Журнал выполнения</h2>
              <p className="text-xs text-slate-500">Пошаговая трассировка job’ов (без секретов). Последние 60 записей.</p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-sm">
                <thead className="border-y border-slate-200 bg-slate-50 text-left text-xs text-slate-500">
                  <tr>
                    <th className="px-3 py-2">Время</th>
                    <th className="px-3 py-2">Job</th>
                    <th className="px-3 py-2">Этап</th>
                    <th className="px-3 py-2">Деталь</th>
                  </tr>
                </thead>
                <tbody>
                  {execLogs.length === 0 && <tr><td colSpan={4} className="px-3 py-8 text-center text-slate-400">Записей ещё нет</td></tr>}
                  {execLogs.map((l) => (
                    <tr key={l.id} className="border-b border-slate-100 last:border-0">
                      <td className="px-3 py-1.5 text-slate-500">{new Date(l.createdAt).toLocaleString("ru-RU")}</td>
                      <td className="px-3 py-1.5 font-mono text-[11px] text-slate-400">{l.jobId.slice(-6)}</td>
                      <td className="px-3 py-1.5 text-slate-700">{l.stage}</td>
                      <td className="px-3 py-1.5 text-slate-500">{l.detailSafe ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
