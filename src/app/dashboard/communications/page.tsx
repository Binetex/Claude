import { prisma } from "@/lib/db";
import { PageHeader } from "@/components/ui/misc";
import { Card, CardBody } from "@/components/ui/Card";
import { fmtDateTime } from "@/lib/format";
import { listOtherThreads, loadQuoNumberOwners, type OtherThread } from "@/integrations/quo/communicationsService";
import { quoLog } from "@/integrations/quo/logging";
import { TOPIC_LABEL, type TopicKey } from "@/integrations/quo/otherMessages";
import { ThreadTabs, type ThreadTab } from "./ThreadTabs";
import { ThreadList, type ThreadRow } from "./ThreadList";
import { threadHref } from "./threadKey";

export const dynamic = "force-dynamic";

/** По умолчанию — последний месяц: раздел смотрят «что там сейчас», а не всю историю. */
const DEFAULT_DAYS = 30;

/**
 * Вкладки раздела. «Звонки» — не категория, а фильтр по типу: это отдельная просьба владельца
 * («и отдельную категорию для звонков без смс»), и три четверти всех переписок — именно такие.
 * «Ищут работу» и «Служебное» отдельной вкладки не заслуживают (единицы в месяц) и живут в
 * «Прочем», но своим чипом в строке.
 */
const TABS: { key: string; label: string; match: (t: OtherThread) => boolean }[] = [
  { key: "ALL", label: "Все", match: () => true },
  { key: "NEW_ORDER", label: TOPIC_LABEL.NEW_ORDER, match: (t) => t.topic === "NEW_ORDER" },
  { key: "PICKUP", label: TOPIC_LABEL.PICKUP, match: (t) => t.topic === "PICKUP" },
  { key: "DELIVERY", label: TOPIC_LABEL.DELIVERY, match: (t) => t.topic === "DELIVERY" },
  { key: "EXISTING_ORDER", label: TOPIC_LABEL.EXISTING_ORDER, match: (t) => t.topic === "EXISTING_ORDER" },
  { key: "CALLS", label: "Только звонки", match: (t) => t.callsOnly },
  { key: "SPAM", label: TOPIC_LABEL.SPAM, match: (t) => t.topic === "SPAM" },
  { key: "OTHER", label: TOPIC_LABEL.OTHER, match: (t) => t.topic === "OTHER" || t.topic === "JOB" || t.topic === "SERVICE" },
];

function parseDate(v: string | undefined): Date | undefined {
  if (!v) return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export default async function OtherMessagesPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const phone = sp.phone?.trim() || undefined;
  const activeTab = TABS.some((t) => t.key === sp.topic) ? (sp.topic as string) : "ALL";
  const now = new Date();
  const from = parseDate(sp.from) ?? new Date(now.getTime() - DEFAULT_DAYS * 86_400_000);
  // Верхняя граница — начало СЛЕДУЮЩЕГО дня: иначе «По = сегодня» отрезало сегодняшний день
  // целиком и фильтр отдавал пустой список (в сервисе стоит `lt`).
  const toRaw = parseDate(sp.to);
  const to = toRaw ? new Date(toRaw.getTime() + 86_400_000) : undefined;
  // Пустая строка в select — «все магазины»; "NONE" — переписки на номерах, которых нет ни у
  // одного магазина (их пятая часть, и это отдельный разговор с владельцем).
  const storeFilter = sp.store ?? "";

  // Магазин определяется и по основному номеру, и по дополнительным (модель SiteQuoNumber):
  // у магазина бывает несколько номеров, и входящее на второй не должно быть «ничьим».
  const ownerByPn = await loadQuoNumberOwners(prisma);
  const storeOptions = [...ownerByPn.entries()]
    .filter(([, o]) => o.isPrimary)
    .map(([pn, o]) => ({ pn, label: o.shortName || o.name }))
    .sort((a, b) => a.label.localeCompare(b.label, "ru"));

  let threads: OtherThread[] = [];
  let truncated = false;
  let failed = false;
  try {
    const res = await listOtherThreads(prisma, {
      from,
      to,
      phone,
      providerPhoneNumberId: storeFilter && storeFilter !== "NONE" ? storeFilter : undefined,
    });
    threads = res.threads;
    truncated = res.truncated;
  } catch (err) {
    // Раньше здесь был пустой catch, и любая ошибка базы выглядела как «сообщений нет».
    // Молчать об этом нельзя: человек решит, что разбирать нечего.
    failed = true;
    quoLog("other_messages.list_failed", { error: err instanceof Error ? err.message : String(err) });
  }

  if (storeFilter === "NONE") threads = threads.filter((t) => !t.providerPhoneNumberId || !ownerByPn.has(t.providerPhoneNumberId));

  const tabs: ThreadTab[] = TABS.map((t) => ({ key: t.key, label: t.label, count: threads.filter(t.match).length }));
  const shown = threads.filter(TABS.find((t) => t.key === activeTab)!.match);

  const rows: ThreadRow[] = shown.slice(0, 300).map((t) => {
    const owner = t.providerPhoneNumberId ? ownerByPn.get(t.providerPhoneNumberId) : undefined;
    return {
      href: threadHref(t.phone, t.providerPhoneNumberId),
      phoneDisplay: t.phoneDisplay,
      storeLabel: owner ? owner.shortName || owner.name : t.storePhone ?? "магазин не определён",
      storeKnown: !!owner,
      topic: t.topic as TopicKey,
      topicIsManual: t.topicIsManual,
      lastText: t.lastText,
      lastAtLabel: fmtDateTime(t.lastAt),
      smsCount: t.smsCount,
      callCount: t.callCount,
      waitingForUs: t.waitingForUs,
      wantsCall: t.wantsCall,
    };
  });

  return (
    <div className="space-y-4">
      <PageHeader
        title="Другие сообщения"
        description="Звонки и SMS, которые не привязались ни к одному заказу: новые клиенты, самовывоз, доставка и рассылки. Строка — весь разговор с номером; откройте её, чтобы прочитать переписку целиком."
      />

      <ThreadTabs tabs={tabs} active={activeTab} />

      <Card>
        <CardBody>
          <form method="get" className="flex flex-wrap items-end gap-2 text-xs">
            {/* Вкладка едет вместе с фильтром: иначе «Фильтр» молча возвращал бы на «Все». */}
            {activeTab !== "ALL" && <input type="hidden" name="topic" value={activeTab} />}
            <label className="flex flex-col gap-0.5">
              Магазин
              <select name="store" defaultValue={storeFilter} className="rounded border border-slate-300 px-2 py-1">
                <option value="">все</option>
                {storeOptions.map((s) => (
                  <option key={s.pn} value={s.pn}>{s.label}</option>
                ))}
                <option value="NONE">магазин не определён</option>
              </select>
            </label>
            <label className="flex flex-col gap-0.5">
              Номер
              <input name="phone" defaultValue={phone ?? ""} placeholder="+1310…" className="rounded border border-slate-300 px-2 py-1" />
            </label>
            <label className="flex flex-col gap-0.5">
              С
              <input type="date" name="from" defaultValue={sp.from ?? ""} className="rounded border border-slate-300 px-2 py-1" />
            </label>
            <label className="flex flex-col gap-0.5">
              По
              <input type="date" name="to" defaultValue={sp.to ?? ""} className="rounded border border-slate-300 px-2 py-1" />
            </label>
            <button type="submit" className="rounded bg-sky-600 px-3 py-1 font-medium text-white">Фильтр</button>
            {!sp.from && !sp.to && <span className="pb-1 text-slate-400">показан последний месяц</span>}
          </form>
        </CardBody>
      </Card>

      {failed && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          Не удалось прочитать сообщения. Это сбой чтения, а не пустой список — обновите страницу.
        </div>
      )}

      {truncated && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-800">
          Событий за период больше, чем удалось прочитать за раз: показаны самые свежие, числа в строках
          могут быть занижены. Сузьте период или выберите магазин.
        </div>
      )}

      <ThreadList rows={rows} />
      {shown.length > rows.length && (
        <div className="text-center text-xs text-slate-400">
          Показаны первые {rows.length} из {shown.length}. Сузьте период или выберите магазин.
        </div>
      )}
    </div>
  );
}
