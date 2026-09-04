import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { listSmsTriggers } from "@/modules/automations/triggers";
import { SMS_VARIABLES } from "@/modules/messaging/variables";
import { AutomationForm, type AutomationFormInitial } from "../AutomationForm";
import { AutomationDetailTabs } from "./AutomationDetailTabs";
import { JobsPanel, parseFilter, parsePage } from "./JobsPanel";
import type { SmsConditions } from "@/modules/automations/conditions";

export const dynamic = "force-dynamic";

type SP = Record<string, string | string[] | undefined>;
const str = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

function loadAutomation(id: string) {
  return prisma.automation.findUnique({
    where: { id },
    include: { sites: { select: { siteId: true }, orderBy: { createdAt: "asc" } } },
  });
}
type AutomationWithSites = NonNullable<Awaited<ReturnType<typeof loadAutomation>>>;

export default async function EditAutomationPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<SP>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const tab = str(sp.tab) === "stats" ? "stats" : "settings";

  const automation = await loadAutomation(id);
  if (!automation || automation.deletedAt) notFound();

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-xl font-bold text-slate-800">{automation.name}</h1>
        <Link href="/dashboard/automations" className="text-xs text-sky-600 hover:underline">
          ← Ко всем правилам
        </Link>
      </div>

      <AutomationDetailTabs automationId={id} active={tab} />

      {tab === "settings" ? (
        <SettingsTab automation={automation} />
      ) : (
        <JobsPanel automationId={id} filter={parseFilter(str(sp.status))} page={parsePage(str(sp.page))} />
      )}
    </div>
  );
}

/** Справочники формы грузим только на вкладке настройки — на статистике они не нужны. */
async function SettingsTab({ automation }: { automation: AutomationWithSites }) {
  const [sites, recentOrders, otherAutomations] = await Promise.all([
    prisma.site.findMany({ select: { id: true, name: true, quoEnabled: true }, orderBy: { name: "asc" } }),
    prisma.order.findMany({ select: { id: true, orderNumber: true, siteId: true }, orderBy: { createdAt: "desc" }, take: 50 }),
    // Кандидаты на «если не ответят» — живые правила, кроме самого себя: правило, запускающее
    // само себя, писало бы человеку по кругу (сервер это тоже отвергает). Плюс ТЕКУЩАЯ ссылка,
    // даже если то правило уже удалено: иначе поле выглядит пустым, сохранение падает с
    // «правило не найдено», и владельцу нечего снять.
    prisma.automation.findMany({
      where: {
        id: { not: automation.id },
        OR: [{ deletedAt: null }, ...(automation.noReplyNextAutomationId ? [{ id: automation.noReplyNextAutomationId }] : [])],
      },
      select: { id: true, name: true, active: true, deletedAt: true, sites: { select: { site: { select: { name: true } } } } },
      orderBy: { name: "asc" },
    }),
  ]);

  const triggers = listSmsTriggers().map((t) => ({ type: t.type, label: t.label, description: t.description }));
  const variables = SMS_VARIABLES.map((v) => ({ key: v.key, label: v.label, example: v.example }));

  const initial: AutomationFormInitial = {
    id: automation.id,
    siteIds: automation.sites.map((s) => s.siteId),
    name: automation.name,
    active: automation.active,
    smsEnabled: automation.smsEnabled,
    emailEnabled: automation.emailEnabled,
    emailFallbackEnabled: automation.emailFallbackEnabled,
    brevoTemplateId: automation.brevoTemplateId,
    triggerType: automation.triggerType,
    audience: automation.audience,
    delayAmount: automation.delayAmount,
    delayUnit: automation.delayUnit,
    template: automation.template,
    conditions: (automation.conditionsJson as SmsConditions | null) ?? { excludeCancelledRefunded: true },
    noReplyNextAutomationId: automation.noReplyNextAutomationId,
  };

  return (
    <AutomationForm
      initial={initial}
      sites={sites}
      recentOrders={recentOrders}
      triggers={triggers}
      variables={variables}
      otherAutomations={otherAutomations.map((a) => ({
        id: a.id,
        name: a.name,
        active: a.active,
        deleted: !!a.deletedAt,
        siteNames: a.sites.map((x) => x.site.name),
      }))}
      showHeader={false}
    />
  );
}
