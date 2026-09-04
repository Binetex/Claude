import Link from "next/link";
import { prisma } from "@/lib/db";
import { Card, CardBody } from "@/components/ui/Card";
import { Button } from "@/components/ui/button";
import { getSmsTrigger, CHAINED_TRIGGER } from "@/modules/automations/triggers";
import { orderByChain, formatWait } from "@/modules/automations/chain";
import { audienceLabel, delayLabel } from "@/modules/automations/display";
import { getAutomationSettings } from "@/modules/automations/settings";
import { AutomationsTabs } from "./AutomationsTabs";
import { StatTiles, type StatTile } from "./StatTiles";
import { AutomationRowActions } from "./AutomationRowActions";
import { SiteReviewUrlPanel } from "./SiteReviewUrlPanel";
import { KillSwitchToggle } from "./KillSwitchToggle";

export const dynamic = "force-dynamic";

export default async function AutomationsPage() {
  const [automations, statRows, channelRows, lastRuns, sites, settings] = await Promise.all([
    prisma.automation.findMany({
      where: { deletedAt: null },
      include: { sites: { select: { siteId: true, site: { select: { name: true } } }, orderBy: { createdAt: "asc" } } },
      orderBy: [{ createdAt: "desc" }],
    }),
    prisma.automationJob.groupBy({ by: ["automationId", "status"], _count: { _all: true } }),
    prisma.automationJob.groupBy({ by: ["channel", "status"], _count: { _all: true } }),
    prisma.automationJob.groupBy({ by: ["automationId"], _max: { sentAt: true } }),
    prisma.site.findMany({ select: { id: true, name: true, quoEnabled: true, automationDailyLocalTime: true, awaitReplyFirstMin: true, awaitReplyNextMin: true }, orderBy: { name: "asc" } }),
    getAutomationSettings(prisma),
  ]);

  // Цепочка хранится ссылками по id, а читать её должен человек: показываем и «куда ведёт»,
  // и «кто ведёт сюда» — иначе шаг цепочки выглядит правилом, которое просто не срабатывает.
  const ruleById = new Map(automations.map((a) => [a.id, a]));
  const calledBy = new Map<string, string[]>();
  for (const a of automations) {
    if (!a.noReplyNextAutomationId) continue;
    const list = calledBy.get(a.noReplyNextAutomationId) ?? [];
    list.push(a.name);
    calledBy.set(a.noReplyNextAutomationId, list);
  }

  // Метрики по каждому правилу из групп статусов.
  const stats = new Map<string, { sent: number; failed: number; skipped: number; cancelled: number; scheduled: number }>();
  const bump = (id: string) => stats.get(id) ?? stats.set(id, { sent: 0, failed: 0, skipped: 0, cancelled: 0, scheduled: 0 }).get(id)!;
  for (const r of statRows) {
    const s = bump(r.automationId);
    if (r.status === "SENT") s.sent += r._count._all;
    else if (r.status === "FAILED") s.failed += r._count._all;
    else if (r.status === "SKIPPED") s.skipped += r._count._all;
    else if (r.status === "CANCELLED") s.cancelled += r._count._all;
    else if (r.status === "SCHEDULED" || r.status === "PROCESSING") s.scheduled += r._count._all;
  }
  // Сводка считается по AutomationJob — то есть только по нашим отправкам через API (у каждой есть
  // sendKey и связь job→OrderCommunication). Переписка сотрудников, приехавшая вебхуком QUO, живёт
  // в OrderCommunication без sendKey и без job — в эти числа она не попадает by design.
  // SMS и Email считаются раздельно: смешивать каналы в одной цифре нельзя.
  const byChannel = {
    SMS: { sent: 0, failed: 0, skipped: 0, scheduled: 0 },
    EMAIL: { sent: 0, failed: 0, skipped: 0, scheduled: 0 },
  };
  for (const r of channelRows) {
    const t = r.channel === "EMAIL" ? byChannel.EMAIL : byChannel.SMS;
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

  const lastRunByAuto = new Map<string, Date | null>();
  for (const r of lastRuns) lastRunByAuto.set(r.automationId, r._max.sentAt);

  const successRate = (s?: { sent: number; failed: number }) => {
    if (!s) return "—";
    const denom = s.sent + s.failed;
    if (denom === 0) return "—";
    return `${Math.round((s.sent / denom) * 100)}%`;
  };

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <h1 className="text-xl font-bold text-slate-800">Автоматизации</h1>

      <AutomationsTabs />

      <div className="space-y-3">
        <StatTiles tiles={channelTiles(byChannel.SMS, "sms")} caption="SMS через API" />
        <StatTiles tiles={channelTiles(byChannel.EMAIL, "email")} caption="Email через API" />
        <p className="text-[11px] text-slate-400">
          Только отправки правил. Переписка сотрудников из QUO и шаги Marketing Flows сюда не входят.
        </p>
      </div>

      <div className="flex justify-end">
        <Link href="/dashboard/automations/new">
          <Button size="sm">Создать автоматизацию</Button>
        </Link>
      </div>

      {/* Рубильник общий: гасит и одиночные правила, и цепочки. */}
      <KillSwitchToggle disableAll={settings.disableAll} updatedAt={settings.updatedAt ? settings.updatedAt.toISOString() : null} />

      <Card>
        <CardBody className="overflow-x-auto p-0">
          <table className="w-full min-w-[1040px] text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs text-slate-500">
              <tr>
                <th className="px-3 py-2">Название</th>
                <th className="px-3 py-2">Магазины</th>
                <th className="px-3 py-2">Канал</th>
                <th className="px-3 py-2">Событие</th>
                <th className="px-3 py-2">Аудитория</th>
                <th className="px-3 py-2">Задержка</th>
                <th className="px-3 py-2">Статус</th>
                <th className="px-3 py-2 text-right">Отпр.</th>
                <th className="px-3 py-2 text-right">Ошиб.</th>
                <th className="px-3 py-2 text-right">Проп.</th>
                <th className="px-3 py-2 text-right">Success</th>
                <th className="px-3 py-2">Последний</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {automations.length === 0 && (
                <tr><td colSpan={13} className="px-3 py-10 text-center text-slate-400">Автоматизаций пока нет</td></tr>
              )}
              {orderByChain(automations).map(({ rule: a, depth }) => {
                const trigger = getSmsTrigger(a.triggerType);
                const lastRun = lastRunByAuto.get(a.id) ?? null;
                const s = stats.get(a.id);
                return (
                  <tr key={a.id} className="border-b border-slate-100 last:border-0">
                    <td className="px-3 py-2">
                      {/* Шаг цепочки стоит прямо под своим правилом и со сдвигом: иначе лесенку
                          не увидеть — карточки лежат в списке далеко друг от друга. */}
                      <div style={depth ? { paddingLeft: depth * 14 } : undefined} className="flex items-baseline gap-1">
                        {depth > 0 && <span className="text-slate-300" aria-hidden>└</span>}
                        <Link href={`/dashboard/automations/${a.id}`} className="font-medium text-slate-800 hover:underline">{a.name}</Link>
                      </div>
                      {a.noReplyNextAutomationId && (
                        <span className="mt-0.5 block text-[11px] text-slate-500" style={{ paddingLeft: depth * 14 + 12 }}>
                          ждёт ответ {a.noReplyAfterMin != null ? formatWait(a.noReplyAfterMin) : "по сроку магазина"}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-slate-600">
                      {/* Одна карточка на правило: сводка + раскрытие полного списка магазинов. */}
                      {a.sites.length === 0 ? (
                        <span className="text-amber-600">Магазины не выбраны</span>
                      ) : (
                        <details className="group">
                          <summary className="cursor-pointer list-none whitespace-nowrap text-slate-700 hover:underline">
                            {a.sites.length === sites.length ? `Все магазины (${sites.length})` : `Магазинов: ${a.sites.length}`}
                            <span className="ml-1 text-slate-400 group-open:hidden">▾</span>
                            <span className="ml-1 hidden text-slate-400 group-open:inline">▴</span>
                          </summary>
                          <ul className="mt-1 space-y-0.5 text-[11px] text-slate-500">
                            {a.sites.map((s) => <li key={s.site.name}>{s.site.name}</li>)}
                          </ul>
                        </details>
                      )}
                    </td>
                    <td className="px-3 py-2 text-slate-600">
                      <span className="flex flex-wrap items-center gap-1">
                        {a.smsEnabled && <span className="rounded border border-sky-200 bg-sky-50 px-1.5 py-px text-[11px] text-sky-700">SMS</span>}
                        {a.emailEnabled && <span className="rounded border border-violet-200 bg-violet-50 px-1.5 py-px text-[11px] text-violet-700">Email</span>}
                        {a.emailFallbackEnabled && <span className="rounded border border-slate-200 bg-slate-50 px-1.5 py-px text-[11px] text-slate-500">+ fallback</span>}
                        {!a.smsEnabled && !a.emailEnabled && <span className="text-amber-600">Канал не выбран</span>}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      {trigger ? (
                        <span className="text-slate-700">{trigger.label}</span>
                      ) : (
                        <span className="rounded border border-amber-200 bg-amber-50 px-1.5 py-px text-[11px] text-amber-700">Unsupported: {a.triggerType}</span>
                      )}
                      {/* Шаг цепочки сам не срабатывает — без этой строки он выглядит сломанным.
                          Показываем «← из» и у обычного правила: если на него ссылаются, оно
                          уходит ЕЩЁ И по цепочке, и это должно быть видно снаружи карточки. */}
                      {(a.triggerType === CHAINED_TRIGGER || calledBy.get(a.id)?.length) && (
                        <span className="mt-0.5 block text-[11px] text-slate-500">
                          {calledBy.get(a.id)?.length
                            ? `← из: ${calledBy.get(a.id)!.join(", ")}`
                            : "⚠ никто не запускает — правило не сработает"}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-slate-600">
                      {audienceLabel(a.audience)}
                      {/* Цепочка иначе видна только внутри карточки: снаружи должно читаться,
                          что правило ждёт ответа и кого позовёт, если ответа не будет. */}
                      {a.noReplyNextAutomationId && (() => {
                        const nextRule = ruleById.get(a.noReplyNextAutomationId);
                        // Третий способ сломать цепочку — потерять общий магазин: шаг запускается
                        // в магазине заказа, и без пересечения он молча не дойдёт ни разу.
                        const shared = nextRule
                          ? a.sites.some((x) => nextRule.sites.some((y) => y.siteId === x.siteId))
                          : false;
                        const problem = !nextRule
                          ? "правило удалено"
                          : !nextRule.active
                            ? "выключено"
                            : !shared
                              ? "нет общего магазина"
                              : null;
                        return (
                          <span
                            className={`ml-1 whitespace-nowrap rounded border px-1.5 py-px text-[11px] ${problem ? "border-red-200 bg-red-50 text-red-700" : "border-amber-200 bg-amber-50 text-amber-700"}`}
                            title="Если не ответят — запустится это правило"
                          >
                            → {nextRule ? nextRule.name : "правило удалено"}
                            {problem && nextRule ? ` (${problem})` : ""}
                          </span>
                        );
                      })()}
                    </td>
                    <td className="px-3 py-2 text-slate-600">{delayLabel(a.delayAmount, a.delayUnit)}</td>
                    <td className="px-3 py-2">
                      {a.active ? (
                        <span className="rounded border border-emerald-200 bg-emerald-50 px-1.5 py-px text-[11px] font-medium text-emerald-700">Active</span>
                      ) : (
                        <span className="rounded border border-slate-200 bg-slate-50 px-1.5 py-px text-[11px] font-medium text-slate-500">Disabled</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-700">{s?.sent ?? 0}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-700">{s?.failed ?? 0}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-500">{s?.skipped ?? 0}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-700">{successRate(s)}</td>
                    <td className="px-3 py-2 text-slate-500">{lastRun ? new Date(lastRun).toLocaleString("ru-RU") : "—"}</td>
                    <td className="px-3 py-2">
                      <AutomationRowActions id={a.id} active={a.active} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </CardBody>
      </Card>

      <SiteReviewUrlPanel sites={sites} />
    </div>
  );
}
