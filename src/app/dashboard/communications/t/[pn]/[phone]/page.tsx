import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { Card, CardHeader, CardTitle, CardBody } from "@/components/ui/Card";
import { CommunicationTimeline } from "@/components/orders/CommunicationTimeline";
import { fmtDateTime } from "@/lib/format";
import { pluralRu } from "@/lib/plural";
import { requireUser } from "@/lib/rbac";
import { loadPhoneCommunicationsCard, suggestOrdersForCommunication } from "@/integrations/quo/communicationsService";
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

  const site = pn
    ? await prisma.site.findFirst({
        where: { quoPhoneNumberId: pn },
        select: { id: true, name: true, shortName: true, quoPhoneNumber: true, quoEnabled: true },
      })
    : null;

  const { communications, storeHasQuoNumber, storeTimeZone } = await loadPhoneCommunicationsCard(prisma, {
    phoneE164: phone,
    siteId: site?.id ?? null,
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

  const suggestions = await suggestOrdersForCommunication(prisma, rows[0].id);

  // Числа шапки считаем по НЕПРИВЯЗАННЫМ событиям — ровно тем, что показаны строкой в списке.
  // Лента ниже намеренно шире: в ней видна и переписка, уже привязанная к заказам, — без неё
  // разговор читался бы кусками.
  const smsCount = rows.filter((r) => r.type === "SMS").length;
  const callCount = rows.length - smsCount;
  const first = rows[rows.length - 1];
  const last = rows[0];
  const linkedCount = communications.length - rows.length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Link href="/dashboard/communications" className="text-sm text-slate-400 hover:text-slate-600">← Другие сообщения</Link>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h1 className="text-xl font-bold text-slate-800 tabular-nums">{communications[0].externalPhone}</h1>
        <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] text-slate-600">
          {site ? `${site.shortName || site.name} · ${site.quoPhoneNumber ?? ""}` : "магазин не определён"}
        </span>
        <span className="rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[11px] text-slate-600">
          {TOPIC_LABEL[topic]}
          {manual && <span className="ml-1 opacity-60">вручную</span>}
        </span>
      </div>

      <div className="text-xs text-slate-500">
        {smsCount > 0 && <>{smsCount} SMS · </>}
        {callCount > 0 && <>{callCount} {pluralRu(callCount, "звонок", "звонка", "звонков")} · </>}
        первый контакт {fmtDateTime(first.occurredAt)} · последний {fmtDateTime(last.occurredAt)}
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
          siteId={site?.id ?? null}
          storeCanSend={storeHasQuoNumber}
          storeName={site ? site.shortName || site.name : NO_STORE}
          topic={topic}
          topicIsManual={!!manual}
          suggestions={suggestions.map((s) => ({ orderId: s.orderId, orderNumber: s.orderNumber, role: s.role }))}
        />
      </div>
    </div>
  );
}
