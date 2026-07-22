import Link from "next/link";
import { requireRole } from "@/lib/rbac";
import { loadPrintableCards } from "@/modules/print/loadPrintable";
import { ownerUpdateCardMessage } from "../actions";
import { PrintNoteRow } from "@/app/print/order-cards/PrintNoteRow";

/** Владелец: печать открыток на сегодня по всем магазинам. */
export const dynamic = "force-dynamic";

export default async function OwnerPrintCards({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const user = await requireRole("OWNER");
  const sp = await searchParams;
  const siteId = sp.siteId?.trim() || undefined;

  const orders = await loadPrintableCards({ role: user.role }, { todayAll: true, includeBlank: true, siteId });
  const sites = Array.from(new Map(orders.map((o) => [o.siteId, o.siteName])).entries());
  const printableCount = orders.filter((o) => o.hasCardMessage).length;

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <h1 className="text-lg font-semibold text-slate-900">Печать открыток</h1>

      <div className="flex flex-wrap items-center gap-2">
        <a
          href="/print/order-cards?today=1"
          target="_blank"
          rel="noopener noreferrer"
          className={`rounded-md px-4 py-2 text-sm font-medium text-white ${printableCount ? "bg-emerald-600" : "pointer-events-none bg-slate-300"}`}
        >
          Печать всех на сегодня ({printableCount})
        </a>
        {sites.length > 1 && (
          <div className="flex flex-wrap gap-1">
            <Link href="/dashboard/print-cards" className={`rounded-full px-3 py-1.5 text-xs ${!siteId ? "bg-slate-800 text-white" : "bg-white text-slate-600 border border-slate-200"}`}>Все магазины</Link>
            {sites.map(([id, name]) => (
              <Link key={id} href={`/dashboard/print-cards?siteId=${id}`} className={`rounded-full px-3 py-1.5 text-xs ${siteId === id ? "bg-slate-800 text-white" : "bg-white text-slate-600 border border-slate-200"}`}>{name}</Link>
            ))}
          </div>
        )}
      </div>

      {orders.length === 0 && <div className="py-12 text-center text-sm text-slate-400">На сегодня заказов нет</div>}

      <div className="space-y-3">
        {orders.map((o) => (
          <PrintNoteRow
            key={o.orderId}
            order={{ orderId: o.orderId, orderNumber: o.orderNumber, recipientName: o.recipientName, deliveryDate: o.deliveryDate, cardMessage: o.cardMessage, hasCardMessage: o.hasCardMessage, siteName: o.siteName }}
            save={ownerUpdateCardMessage}
          />
        ))}
      </div>
    </div>
  );
}
