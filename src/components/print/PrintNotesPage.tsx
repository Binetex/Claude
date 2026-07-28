import Link from "next/link";
import { PrintNoteRow, type SaveResult } from "@/app/print/order-cards/PrintNoteRow";
import { PageHeader } from "@/components/ui/misc";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import type { PrintOrder, PrintDay } from "@/modules/print/loadPrintable";

/**
 * Общий экран «Печать записок» для владельца и флориста. Роли отличаются только тем, ЧТО им
 * отдал loadPrintableCards (владелец — все магазины, флорист — свои заказы) и каким действием
 * сохраняется текст. Вёрстка и переключатели общие, чтобы не расходились при доработках.
 */
export function PrintNotesPage({
  basePath,
  title,
  orders,
  day,
  siteId,
  save,
  backHref,
  backLabel,
}: {
  basePath: string;
  title: string;
  orders: PrintOrder[];
  day: PrintDay;
  siteId?: string;
  save: (orderId: string, text: string) => Promise<SaveResult>;
  backHref?: string;
  backLabel?: string;
}) {
  const sites = Array.from(new Map(orders.map((o) => [o.siteId, o.siteName])).entries());
  const printableCount = orders.filter((o) => o.hasCardMessage).length;

  /** Ссылка на этот же экран с другим днём/магазином — состояние живёт в URL. */
  const href = (next: { day?: PrintDay; siteId?: string | null }) => {
    const p = new URLSearchParams();
    const d = next.day ?? day;
    if (d !== "today") p.set("day", d);
    const s = next.siteId === null ? undefined : next.siteId ?? siteId;
    if (s) p.set("siteId", s);
    const q = p.toString();
    return q ? `${basePath}?${q}` : basePath;
  };

  const printHref = `/print/order-cards?day=${day}${siteId ? `&siteId=${siteId}` : ""}`;
  const dayLabel = day === "today" ? "сегодня" : "завтра";

  return (
    <div className="space-y-4">
      <PageHeader
        title={title}
        actions={
          backHref ? (
            <Button asChild variant="outline" size="sm">
              <Link href={backHref}>{backLabel ?? "Назад"}</Link>
            </Button>
          ) : undefined
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        {/* День доставки — сегментированные вкладки, как в списке заказов. */}
        <div className="flex items-center gap-0.5 rounded-lg bg-slate-100 p-0.5">
          {(["today", "tomorrow"] as const).map((d) => (
            <Link
              key={d}
              href={href({ day: d })}
              className={cn(
                "rounded-md px-3 py-1 text-sm font-medium transition-colors",
                day === d ? "bg-white text-slate-900 shadow-xs" : "text-slate-500 hover:text-slate-800"
              )}
            >
              {d === "today" ? "Сегодня" : "Завтра"}
            </Link>
          ))}
        </div>

        <a
          href={printHref}
          target="_blank"
          rel="noopener noreferrer"
          className={cn(
            "rounded-md px-4 py-2 text-sm font-medium text-white transition-colors",
            printableCount ? "bg-slate-900 hover:bg-slate-800" : "pointer-events-none bg-slate-300"
          )}
        >
          Печать всех на {dayLabel} ({printableCount})
        </a>

        {sites.length > 1 && (
          <div className="flex flex-wrap gap-1">
            <Link
              href={href({ siteId: null })}
              className={cn(
                "rounded-full px-3 py-1.5 text-xs",
                !siteId ? "bg-slate-800 text-white" : "border border-slate-200 bg-white text-slate-600"
              )}
            >
              Все магазины
            </Link>
            {sites.map(([id, name]) => (
              <Link
                key={id}
                href={href({ siteId: id })}
                className={cn(
                  "rounded-full px-3 py-1.5 text-xs",
                  siteId === id ? "bg-slate-800 text-white" : "border border-slate-200 bg-white text-slate-600"
                )}
              >
                {name}
              </Link>
            ))}
          </div>
        )}
      </div>

      {orders.length === 0 && (
        <div className="py-12 text-center text-sm text-slate-400">На {dayLabel} заказов нет</div>
      )}

      <div className="space-y-3">
        {orders.map((o) => (
          <PrintNoteRow
            key={o.orderId}
            order={{
              orderId: o.orderId,
              orderNumber: o.orderNumber,
              recipientName: o.recipientName,
              deliveryDate: o.deliveryDate,
              cardMessage: o.cardMessage,
              hasCardMessage: o.hasCardMessage,
              siteName: o.siteName,
            }}
            save={save}
          />
        ))}
      </div>
    </div>
  );
}

/** Разбор ?day= из URL. Всё, кроме «tomorrow», — сегодня. */
export function parsePrintDay(raw?: string): PrintDay {
  return raw === "tomorrow" ? "tomorrow" : "today";
}
