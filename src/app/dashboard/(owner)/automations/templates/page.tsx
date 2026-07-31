import Link from "next/link";
import { prisma } from "@/lib/db";
import { Card, CardBody } from "@/components/ui/Card";
import { getSmsTrigger } from "@/modules/automations/triggers";
import { AutomationsTabs } from "../AutomationsTabs";

export const dynamic = "force-dynamic";

/**
 * Сводка Email-шаблонов: какой Brevo Template ID реально уйдёт и откуда он взят.
 * Страница СПРАВОЧНАЯ — редактирование живёт там, где и раньше (настройки магазина,
 * карточка правила, редактор цепочки), чтобы не появилось второго места правды.
 */
export default async function TemplatesPage() {
  const [siteTemplates, rules, flows] = await Promise.all([
    prisma.siteEmailTemplate.findMany({
      include: { site: { select: { name: true, emailSettings: { select: { enabled: true, domainVerifiedAt: true } } } } },
      orderBy: [{ site: { name: "asc" } }, { triggerType: "asc" }],
    }),
    prisma.automation.findMany({
      where: { deletedAt: null, brevoTemplateId: { not: null } },
      select: { id: true, name: true, triggerType: true, brevoTemplateId: true, active: true },
      orderBy: { name: "asc" },
    }),
    prisma.automationFlow.findMany({
      where: { deletedAt: null },
      select: {
        id: true,
        name: true,
        active: true,
        triggerType: true,
        steps: { where: { deletedAt: null, type: "EMAIL" }, select: { id: true, position: true, brevoTemplateId: true }, orderBy: { position: "asc" } },
      },
      orderBy: { name: "asc" },
    }),
  ]);

  const flowsWithEmail = flows.filter((f) => f.steps.length > 0);
  const triggerLabel = (t: string) => getSmsTrigger(t)?.label ?? t;

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <div>
        <h1 className="text-xl font-bold text-slate-800">Автоматизации</h1>
        <p className="text-sm text-slate-500">Templates — какие Brevo-шаблоны используются и откуда берутся.</p>
      </div>

      <AutomationsTabs />

      <Card>
        <CardBody className="space-y-2 p-0">
          <div className="border-b border-slate-100 px-3 py-2">
            <h2 className="text-sm font-semibold text-slate-800">Шаблоны магазинов</h2>
            <p className="text-[11px] text-slate-500">
              Общий шаблон магазина под событие. Используется одиночными правилами, у которых не задан свой Template ID. Настраивается в{" "}
              <Link href="/dashboard/sites" className="text-sky-600 hover:underline">
                настройках магазина
              </Link>
              .
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs text-slate-500">
                <tr>
                  <th className="px-3 py-2">Магазин</th>
                  <th className="px-3 py-2">Событие</th>
                  <th className="px-3 py-2">Template ID</th>
                  <th className="px-3 py-2">Email магазина</th>
                </tr>
              </thead>
              <tbody>
                {siteTemplates.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-3 py-8 text-center text-slate-400">
                      Шаблоны магазинов не заданы
                    </td>
                  </tr>
                )}
                {siteTemplates.map((t) => {
                  const ready = !!t.site.emailSettings?.enabled && !!t.site.emailSettings?.domainVerifiedAt;
                  return (
                    <tr key={t.id} className="border-b border-slate-100 last:border-0">
                      <td className="px-3 py-2 text-slate-700">{t.site.name}</td>
                      <td className="px-3 py-2 text-slate-600">{triggerLabel(t.triggerType)}</td>
                      <td className="px-3 py-2 font-mono text-xs text-slate-700">#{t.brevoTemplateId}</td>
                      <td className="px-3 py-2">
                        {ready ? (
                          <span className="rounded border border-emerald-200 bg-emerald-50 px-1.5 py-px text-[11px] text-emerald-700">Готов к отправке</span>
                        ) : (
                          <span className="rounded border border-amber-200 bg-amber-50 px-1.5 py-px text-[11px] text-amber-700">Email не настроен</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardBody className="space-y-2 p-0">
          <div className="border-b border-slate-100 px-3 py-2">
            <h2 className="text-sm font-semibold text-slate-800">Свой шаблон у правила</h2>
            <p className="text-[11px] text-slate-500">Правила Order Notifications, которые перекрывают общий шаблон магазина.</p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs text-slate-500">
                <tr>
                  <th className="px-3 py-2">Правило</th>
                  <th className="px-3 py-2">Событие</th>
                  <th className="px-3 py-2">Template ID</th>
                  <th className="px-3 py-2">Статус</th>
                </tr>
              </thead>
              <tbody>
                {rules.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-3 py-8 text-center text-slate-400">
                      Правил со своим шаблоном нет
                    </td>
                  </tr>
                )}
                {rules.map((r) => (
                  <tr key={r.id} className="border-b border-slate-100 last:border-0">
                    <td className="px-3 py-2">
                      <Link href={`/dashboard/automations/${r.id}`} className="text-slate-800 hover:underline">
                        {r.name}
                      </Link>
                    </td>
                    <td className="px-3 py-2 text-slate-600">{triggerLabel(r.triggerType)}</td>
                    <td className="px-3 py-2 font-mono text-xs text-slate-700">#{r.brevoTemplateId}</td>
                    <td className="px-3 py-2 text-[11px] text-slate-500">{r.active ? "Включено" : "Выключено"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardBody className="space-y-2 p-0">
          <div className="border-b border-slate-100 px-3 py-2">
            <h2 className="text-sm font-semibold text-slate-800">Шаблоны в цепочках</h2>
            <p className="text-[11px] text-slate-500">
              У Email-шага цепочки шаблон всегда свой — общий шаблон магазина для цепочек не используется.
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs text-slate-500">
                <tr>
                  <th className="px-3 py-2">Цепочка</th>
                  <th className="px-3 py-2">Событие</th>
                  <th className="px-3 py-2">Email-шаги</th>
                  <th className="px-3 py-2">Статус</th>
                </tr>
              </thead>
              <tbody>
                {flowsWithEmail.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-3 py-8 text-center text-slate-400">
                      Цепочек с письмами нет
                    </td>
                  </tr>
                )}
                {flowsWithEmail.map((f) => (
                  <tr key={f.id} className="border-b border-slate-100 last:border-0">
                    <td className="px-3 py-2">
                      <Link href={`/dashboard/automations/flows/${f.id}`} className="text-slate-800 hover:underline">
                        {f.name}
                      </Link>
                    </td>
                    <td className="px-3 py-2 text-slate-600">{triggerLabel(f.triggerType)}</td>
                    <td className="px-3 py-2 text-xs text-slate-700">
                      {f.steps.map((s) => (
                        <span key={s.id} className="mr-2 whitespace-nowrap">
                          <span className="text-slate-400">шаг {s.position}:</span>{" "}
                          {s.brevoTemplateId ? <span className="font-mono">#{s.brevoTemplateId}</span> : <span className="text-amber-600">не задан</span>}
                        </span>
                      ))}
                    </td>
                    <td className="px-3 py-2 text-[11px] text-slate-500">{f.active ? "Включена" : "Выключена"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardBody>
      </Card>
    </div>
  );
}
