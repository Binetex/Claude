import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { Card, CardHeader, CardTitle, CardBody } from "@/components/ui/Card";
import { CommunicationTimeline } from "@/components/orders/CommunicationTimeline";
import { fmtDateTime } from "@/lib/format";
import { pluralRu } from "@/lib/plural";
import { requireUser } from "@/lib/rbac";
import { loadPhoneCommunicationsCard, suggestOrdersForCommunication, findSiteByQuoNumber } from "@/integrations/quo/communicationsService";
import { classifyThread, isTopicKey, TOPIC_LABEL, type TopicKey } from "@/integrations/quo/otherMessages";
import { ThreadActions } from "../../../ThreadActions";
import { parseThreadPn, decodeSegment, NO_STORE } from "../../../threadKey";

export const dynamic = "force-dynamic";

/**
 * Вся переписка с одним номером в рамках одного магазина.
 *
 * Лента — тот же компонент, что в карточке заказа (components/orders/CommunicationTimeline):
 * владелец уже знает этот вид, и звонки с записью, транскриптом и MMS в нём уже работают.
 * Второй ленты в проекте быть не должно.
 */
export default async function ThreadPage({ params }: { params: Promise<{ pn: string; phone: string }> }) {
  await requireUser();
  const { pn: pnRaw, phone: phoneRaw } = await params;
  const phone = decodeSegment(phoneRaw);
  const pn = parseThreadPn(pnRaw);
  if (!phone) notFound();

  // Магазин ищем и среди дополнительных номеров — ОДНИМ запросом: человек мог написать на
  // второй номер магазина.
  const owner = pn ? await findSiteByQuoNumber(prisma, pn) : null;

  const { communications, storeHasQuoNumber, storeTimeZone } = await loadPhoneCommunicationsCard(prisma, {
    phoneE164: phone,
    siteId: owner?.siteId ?? null,
    providerPhoneNumberId: pn,
    take: 300,
  });

  // Категория считается по тем же входящим текстам, что и в списке, — иначе строка и карточка
  // показывали бы разное. Ручная метка живёт на самих событиях.
  const rows = await prisma.orderCommunication.findMany({
    where: { orderId: null, ignoredAt: null, externalPhoneNormalized: phone, providerPhoneNumberId: pn },
    select: { id: true, type: true, direction: true, messageText: true, transcript: true, summary: true, topicManual: true, occurredAt: true },
    orderBy: { occurredAt: "desc" },
    take: 300,
  });
  const manual = rows.find((r) => r.topicManual && isTopicKey(r.topicManual))?.topicManual ?? null;
  const topic: TopicKey =
    manual && isTopicKey(manual)
      ? manual
      : classifyThread(rows.filter((r) => r.direction === "INBOUND").map((r) => [r.messageText, r.transcript, r.summary].filter(Boolean).join(" ")));

  // Переписки нет: все её события уже уехали в заказы или скрыты — показывать нечего.
  if (rows.length === 0) notFound();

  const threadWhere = { externalPhoneNormalized: phone, providerPhoneNumberId: pn } as const;

  // Числа шапки считаем ЗАПРОСАМИ, а не по загруженным 300 строкам: иначе на длинной переписке
  // «первый контакт» показывал бы трёхсотое с конца событие, а счётчики молча занижались.
  const [suggestions, byType, span, linkedCount] = await Promise.all([
    suggestOrdersForCommunication(prisma, rows[0].id),
    prisma.orderCommunication.groupBy({
      by: ["type"],
      where: { ...threadWhere, orderId: null, ignoredAt: null },
      _count: { _all: true },
    }),
    prisma.orderCommunication.aggregate({
      where: { ...threadWhere, orderId: null, ignoredAt: null },
      _min: { occurredAt: true },
      _max: { occurredAt: true },
    }),
    prisma.orderCommunication.count({ where: { ...threadWhere, orderId: { not: null } } }),
  ]);

  const smsCount = byType.find((g) => g.type === "SMS")?._count._all ?? 0;
  const callCount = byType.reduce((n, g) => (g.type === "SMS" ? n : n + g._count._all), 0);
  const firstAt = span._min.occurredAt;
  const lastAt = span._max.occurredAt;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Link href="/dashboard/communications" className="text-sm text-slate-400 hover:text-slate-600">← Другие сообщения</Link>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h1 className="text-xl font-bold text-slate-800 tabular-nums">{communications[0].externalPhone}</h1>
        <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] text-slate-600">
          {owner ? `${owner.shortName || owner.name} · ${owner.numberOnThread ?? ""}` : "магазин не определён"}
        </span>
        <span className="rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[11px] text-slate-600">
          {TOPIC_LABEL[topic]}
          {manual && <span className="ml-1 opacity-60">вручную</span>}
        </span>
      </div>

      <div className="text-xs text-slate-500">
        {smsCount > 0 && <>{smsCount} SMS · </>}
        {callCount > 0 && <>{callCount} {pluralRu(callCount, "звонок", "звонка", "звонков")} · </>}
        первый контакт {fmtDateTime(firstAt)} · последний {fmtDateTime(lastAt)}
        {linkedCount > 0 && <> · ещё {linkedCount} по заказам, они видны в ленте</>}
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <Card>
          <CardHeader className="py-2.5"><CardTitle>Переписка</CardTitle></CardHeader>
          <CardBody>
            <CommunicationTimeline items={communications} storeTimeZone={storeTimeZone} inboundLabel="Клиент" />
          </CardBody>
        </Card>

        <ThreadActions
          phone={phone}
          pn={pn ?? ""}
          storeKnown={!!owner}
          storeCanSend={storeHasQuoNumber}
          storeName={owner ? owner.shortName || owner.name : NO_STORE}
          topic={topic}
          topicIsManual={!!manual}
          suggestions={suggestions.map((s) => ({ orderId: s.orderId, orderNumber: s.orderNumber, role: s.role }))}
        />
      </div>
    </div>
  );
}
