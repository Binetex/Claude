import { notFound } from "next/navigation";
import Link from "next/link";
import { prisma } from "@/lib/db";
import { listSmsTriggers } from "@/modules/automations/triggers";
import { SMS_VARIABLES } from "@/modules/automations/variables";
import { AutomationsTabs } from "../../AutomationsTabs";
import { FlowForm } from "../FlowForm";
import { FlowStats } from "../FlowStats";

export const dynamic = "force-dynamic";

export default async function EditFlowPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const [flow, sites] = await Promise.all([
    prisma.automationFlow.findUnique({
      where: { id },
      include: {
        sites: { select: { siteId: true } },
        steps: { where: { deletedAt: null }, orderBy: { position: "asc" } },
      },
    }),
    prisma.site.findMany({ select: { id: true, name: true, quoEnabled: true }, orderBy: { name: "asc" } }),
  ]);
  if (!flow || flow.deletedAt) notFound();

  const triggers = listSmsTriggers().map((t) => ({ type: t.type, label: t.label, description: t.description }));
  const variables = SMS_VARIABLES.map((v) => ({ key: v.key, label: v.label, example: v.example }));

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-bold text-slate-800">
          {flow.name}
          {!flow.active && <span className="ml-2 text-sm font-normal text-slate-500">выключена</span>}
        </h1>
        <Link href="/dashboard/automations/history" className="text-sm text-sky-600 hover:underline">
          История запусков →
        </Link>
      </div>

      <AutomationsTabs />

      <FlowStats flowId={flow.id} />

      <FlowForm
        initial={{
          id: flow.id,
          name: flow.name,
          active: flow.active,
          triggerType: flow.triggerType,
          siteIds: flow.sites.map((s) => s.siteId),
          steps: flow.steps.map((s) => ({
            id: s.id,
            type: s.type,
            waitAmount: s.waitAmount,
            waitUnit: s.waitUnit as "MINUTE" | "HOUR" | "DAY" | null,
            brevoTemplateId: s.brevoTemplateId,
            template: s.template,
          })),
        }}
        sites={sites}
        triggers={triggers}
        variables={variables}
      />
    </div>
  );
}
