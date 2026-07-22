import { prisma } from "@/lib/db";
import { listSmsTriggers } from "@/modules/automations/triggers";
import { SMS_VARIABLES } from "@/modules/automations/variables";
import { AutomationForm } from "../AutomationForm";

export const dynamic = "force-dynamic";

export default async function NewAutomationPage() {
  const [sites, recentOrders] = await Promise.all([
    prisma.site.findMany({ select: { id: true, name: true, quoEnabled: true }, orderBy: { name: "asc" } }),
    prisma.order.findMany({ select: { id: true, orderNumber: true, siteId: true }, orderBy: { createdAt: "desc" }, take: 50 }),
  ]);
  const triggers = listSmsTriggers().map((t) => ({ type: t.type, label: t.label, description: t.description }));
  const variables = SMS_VARIABLES.map((v) => ({ key: v.key, label: v.label, example: v.example }));

  return <AutomationForm initial={null} sites={sites} recentOrders={recentOrders} triggers={triggers} variables={variables} />;
}
