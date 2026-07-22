import { prisma } from "@/lib/db";
import { PageHeader } from "@/components/ui/misc";
import { Card, CardBody } from "@/components/ui/Card";
import { toE164 } from "@/lib/phone";
import { listUnrecognized } from "@/integrations/quo/communicationsService";
import { UnrecognizedList, type Suggestion, type UnrecognizedItemData } from "./UnrecognizedList";

export const dynamic = "force-dynamic";

export default async function UnrecognizedCommunicationsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const type = sp.type === "SMS" || sp.type === "CALL" || sp.type === "VOICEMAIL" ? sp.type : undefined;
  const direction = sp.direction === "INBOUND" || sp.direction === "OUTBOUND" ? sp.direction : undefined;
  const phone = sp.phone?.trim() || undefined;
  const from = sp.from ? new Date(sp.from) : undefined;
  const to = sp.to ? new Date(sp.to) : undefined;

  let items: Awaited<ReturnType<typeof listUnrecognized>> = [];
  const suggByPhone = new Map<string, Suggestion[]>();
  try {
    items = await listUnrecognized(prisma, { type, direction, phone, from, to, take: 60 });
    const phones = [...new Set(items.map((i) => i.externalPhoneNormalized))];
    const candidates = phones.length
      ? await prisma.order.findMany({ where: { OR: phones.flatMap((p) => [{ senderPhone: p }, { recipientPhone: p }]) }, select: { id: true, orderNumber: true, deliveryDate: true, senderPhone: true, recipientPhone: true }, take: 300 })
      : [];
    for (const p of phones) {
      suggByPhone.set(
        p,
        candidates
          .filter((o) => toE164(o.senderPhone) === p || toE164(o.recipientPhone) === p)
          .sort((a, b) => b.deliveryDate.getTime() - a.deliveryDate.getTime())
          .slice(0, 5)
          .map((o) => ({ orderId: o.id, orderNumber: o.orderNumber, role: (toE164(o.senderPhone) === p ? "CUSTOMER" : "RECIPIENT") as "CUSTOMER" | "RECIPIENT" }))
      );
    }
  } catch {
    // QUO-таблицы недоступны — покажем пустой список, страница не падает.
  }

  const uiItems: UnrecognizedItemData[] = items.map((i) => ({
    id: i.id, type: i.type, direction: i.direction, status: i.status, externalPhone: i.externalPhone,
    messageText: i.messageText, durationSeconds: i.durationSeconds, occurredAt: i.occurredAt.toISOString(),
    suggestions: suggByPhone.get(i.externalPhoneNormalized) ?? [],
  }));

  return (
    <div className="space-y-4">
      <PageHeader title={<span className="flex items-baseline gap-2">Нераспознанные коммуникации <span className="text-sm font-normal text-slate-400">{uiItems.length}</span></span>} />

      <Card>
        <CardBody>
          <form method="get" className="flex flex-wrap items-end gap-2 text-xs">
            <label className="flex flex-col gap-0.5">Тип
              <select name="type" defaultValue={type ?? ""} className="rounded border border-slate-300 px-2 py-1">
                <option value="">все</option><option value="SMS">SMS</option><option value="CALL">Звонок</option><option value="VOICEMAIL">Voicemail</option>
              </select>
            </label>
            <label className="flex flex-col gap-0.5">Направление
              <select name="direction" defaultValue={direction ?? ""} className="rounded border border-slate-300 px-2 py-1">
                <option value="">все</option><option value="INBOUND">входящие</option><option value="OUTBOUND">исходящие</option>
              </select>
            </label>
            <label className="flex flex-col gap-0.5">Номер
              <input name="phone" defaultValue={phone ?? ""} placeholder="+1310…" className="rounded border border-slate-300 px-2 py-1" />
            </label>
            <label className="flex flex-col gap-0.5">С
              <input type="date" name="from" defaultValue={sp.from ?? ""} className="rounded border border-slate-300 px-2 py-1" />
            </label>
            <label className="flex flex-col gap-0.5">По
              <input type="date" name="to" defaultValue={sp.to ?? ""} className="rounded border border-slate-300 px-2 py-1" />
            </label>
            <button type="submit" className="rounded bg-sky-600 px-3 py-1 font-medium text-white">Фильтр</button>
          </form>
        </CardBody>
      </Card>

      <UnrecognizedList items={uiItems} />
    </div>
  );
}
