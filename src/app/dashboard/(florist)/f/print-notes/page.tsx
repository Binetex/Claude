import Link from "next/link";
import { requireFlorist } from "@/lib/rbac";
import { loadPrintableCards } from "@/modules/print/loadPrintable";
import { floristUpdateCardMessage } from "../../actions";
import { PrintNoteRow } from "@/app/print/order-cards/PrintNoteRow";

/** Вкладка флориста: печать открыток на сегодня (только назначенные ему заказы). */
export const dynamic = "force-dynamic";

export default async function FloristPrintNotes({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const user = await requireFlorist();
  const sp = await searchParams;
  const siteId = sp.siteId?.trim() || undefined;

  // Список вкладки — все сегодняшние назначенные заказы (в т.ч. без текста открытки, чтобы флорист
  // мог добавить текст). Массовая печать («Все на сегодня») печатает только заказы с текстом.
  const orders = await loadPrintableCards({ role: user.role, floristId: user.floristId }, { todayAll: true, includeBlank: true, siteId });
  const sites = Array.from(new Map(orders.map((o) => [o.siteId, o.siteName])).entries());
  const printableCount = orders.filter((o) => o.hasCardMessage).length;

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-bold text-slate-800">Открытки для печати</h1>
        <Link href="/dashboard/f" className="text-sm text-slate-500 hover:text-slate-700">← Мои заказы</Link>
      </div>

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
            <Link href="/dashboard/f/print-notes" className={`rounded-full px-3 py-1.5 text-xs ${!siteId ? "bg-slate-800 text-white" : "bg-white text-slate-600 border border-slate-200"}`}>Все магазины</Link>
            {sites.map(([id, name]) => (
              <Link key={id} href={`/dashboard/f/print-notes?siteId=${id}`} className={`rounded-full px-3 py-1.5 text-xs ${siteId === id ? "bg-slate-800 text-white" : "bg-white text-slate-600 border border-slate-200"}`}>{name}</Link>
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
            save={floristUpdateCardMessage}
          />
        ))}
      </div>
    </div>
  );
}
