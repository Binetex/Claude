import { prisma } from "@/lib/db";
import { listFlowTriggers } from "@/modules/automations/triggers";
import { SMS_VARIABLES } from "@/modules/messaging/variables";
import { AutomationsTabs } from "../../AutomationsTabs";
import { FlowForm } from "../FlowForm";

export const dynamic = "force-dynamic";

export default async function NewFlowPage() {
  const sites = await prisma.site.findMany({ select: { id: true, name: true, quoEnabled: true }, orderBy: { name: "asc" } });
  const triggers = listFlowTriggers().map((t) => ({ type: t.type, label: t.label, description: t.description }));
  const variables = SMS_VARIABLES.map((v) => ({ key: v.key, label: v.label, example: v.example }));

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <div>
        <h1 className="text-xl font-bold text-slate-800">Новая цепочка</h1>
        <p className="text-sm text-slate-500">Создаётся выключенной — включите её в списке, когда шаги будут готовы.</p>
      </div>
      <AutomationsTabs />
      <FlowForm initial={null} sites={sites} triggers={triggers} variables={variables} />
    </div>
  );
}
