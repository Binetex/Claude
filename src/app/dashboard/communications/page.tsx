import { prisma } from "@/lib/db";
import { PageHeader } from "@/components/ui/misc";
import { Card, CardBody } from "@/components/ui/Card";
import { fmtDateTime } from "@/lib/format";
import { DEFAULT_STORE_TZ, localDateStr, zonedLocalTimeToUtc } from "@/lib/tz";
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

/**
 * Границы периода — по КАЛЕНДАРНОМУ ДНЮ МАГАЗИНА, а не по UTC.
 *
 * Полночь UTC наступает в Лос-Анджелесе в 17:00, поэтому new Date("2026-09-08") как граница
 * отрезала вечер выбранного дня — ровно то время, когда люди и пишут «can I come now».
 */
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function dayStart(dateStr: string | undefined, tz: string): Date | undefined {
  if (!dateStr || !DAY_RE.test(dateStr)) return undefined;
  return zonedLocalTimeToUtc(dateStr, "00:00", tz);
}

/** Конец периода — начало СЛЕДУЮЩЕГО локального дня (в сервисе стоит `lt`). */
function dayAfter(dateStr: string | undefined, tz: string): Date | undefined {
  if (!dateStr || !DAY_RE.test(dateStr)) return undefined;
  const next = new Date(`${dateStr}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return zonedLocalTimeToUtc(next.toISOString().slice(0, 10), "00:00", tz);
}

export default async function OtherMessagesPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const phone = sp.phone?.trim() || undefined;
  const activeTab = TABS.some((t) => t.key === sp.topic) ? (sp.topic as string) : "ALL";
  const now = new Date();
  // Все магазины сейчас в Лос-Анджелесе; когда появятся другие зоны, брать Site.timezone
  // выбранного магазина (см. lib/tz.deliveryDayBucket — там уже описан этот переход).
  const tz = DEFAULT_STORE_TZ;
  const defaultFromDay = new Date(now.getTime() - DEFAULT_DAYS * 86_400_000);
  const from = dayStart(sp.from, tz) ?? dayStart(localDateStr(defaultFromDay, tz), tz);
  const to = dayAfter(sp.to, tz);
  const type = sp.type === "SMS" || sp.type === "CALL" || sp.type === "VOICEMAIL" ? sp.type : undefined;
  const direction = sp.direction === "INBOUND" || sp.direction === "OUTBOUND" ? sp.direction : undefined;
  // Пустая строка в select — «все магазины»; "NONE" — переписки на номерах, которых нет ни у
  // одного магазина (их пятая часть, и это отдельный разговор с владельцем).
  // Значение фильтра — id МАГАЗИНА, а не один его номер: у магазина номеров бывает несколько.
  const storeFilter = sp.store ?? "";

  // Магазин определяется и по основному номеру, и по дополнительным (модель SiteQuoNumber):
  // у магазина бывает несколько номеров, и входящее на второй не должно быть «ничьим».
  const ownerByPn = await loadQuoNumberOwners(prisma);
  const storeOptions = [...new Map([...ownerByPn.values()].map((o) => [o.siteId, o.shortName || o.name])).entries()]
    .map(([siteId, label]) => ({ siteId, label }))
    .sort((a, b) => a.label.localeCompare(b.label, "ru"));
  // Все номера выбранного магазина — основной и дополнительные.
  const filterPns = storeFilter && storeFilter !== "NONE"
    ? [...ownerByPn.entries()].filter(([, o]) => o.siteId === storeFilter).map(([pn]) => pn)
    : undefined;

  let threads: OtherThread[] = [];
  let truncated = false;
  let failed = false;
  try {
    const res = await listOtherThreads(prisma, {
      from,
      to,
      phone,
      providerPhoneNumberIds: filterPns,
      type,
      direction,
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
                  <option key={s.siteId} value={s.siteId}>{s.label}</option>
                ))}
                <option value="NONE">магазин не определён</option>
              </select>
            </label>
            <label className="flex flex-col gap-0.5">
              Тип
              <select name="type" defaultValue={type ?? ""} className="rounded border border-slate-300 px-2 py-1">
                <option value="">все</option>
                <option value="SMS">SMS</option>
                <option value="CALL">звонки</option>
                <option value="VOICEMAIL">voicemail</option>
              </select>
            </label>
            <label className="flex flex-col gap-0.5">
              Направление
              <select name="direction" defaultValue={direction ?? ""} className="rounded border border-slate-300 px-2 py-1">
                <option value="">все</option>
                <option value="INBOUND">входящие</option>
                <option value="OUTBOUND">исходящие</option>
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
