import { prisma } from "@/lib/db";
import { listSmsTriggers } from "@/modules/automations/triggers";
import { SMS_VARIABLES } from "@/modules/messaging/variables";
import { AutomationForm } from "../AutomationForm";

export const dynamic = "force-dynamic";

export default async function NewAutomationPage() {
  const [sites, recentOrders, otherAutomations] = await Promise.all([
    prisma.site.findMany({ select: { id: true, name: true, quoEnabled: true }, orderBy: { name: "asc" } }),
    prisma.order.findMany({ select: { id: true, orderNumber: true, siteId: true }, orderBy: { createdAt: "desc" }, take: 50 }),
    // Кандидаты на «если не ответят» — все живые правила: цепочка не ограничена типом события.
    // Магазины и состояние нужны прямо в подписи: одноимённых правил у разных магазинов много.
    prisma.automation.findMany({
      where: { deletedAt: null },
      select: { id: true, name: true, active: true, sites: { select: { site: { select: { name: true } } } } },
      orderBy: { name: "asc" },
    }),
  ]);
  const triggers = listSmsTriggers().map((t) => ({ type: t.type, label: t.label, description: t.description }));
  const variables = SMS_VARIABLES.map((v) => ({ key: v.key, label: v.label, example: v.example }));

  return (
    <AutomationForm
      initial={null}
      sites={sites}
      recentOrders={recentOrders}
      triggers={triggers}
      variables={variables}
      otherAutomations={otherAutomations.map((a) => ({ id: a.id, name: a.name, active: a.active, siteNames: a.sites.map((x) => x.site.name) }))}
    />
  );
}
