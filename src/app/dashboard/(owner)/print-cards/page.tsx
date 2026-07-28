import { requireRole } from "@/lib/rbac";
import { loadPrintableCards } from "@/modules/print/loadPrintable";
import { ownerUpdateCardMessage } from "../actions";
import { PrintNotesPage, parsePrintDay } from "@/components/print/PrintNotesPage";

/** Владелец: печать записок на сегодня или завтра, по всем магазинам. */
export const dynamic = "force-dynamic";

export default async function OwnerPrintCards({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const user = await requireRole("OWNER");
  const sp = await searchParams;
  const siteId = sp.siteId?.trim() || undefined;
  const day = parsePrintDay(sp.day);

  // includeBlank: в списке видны и заказы без текста — чтобы его можно было дописать.
  const orders = await loadPrintableCards({ role: user.role }, { day, includeBlank: true, siteId });

  return (
    <PrintNotesPage
      basePath="/dashboard/print-cards"
      title="Печать записок"
      orders={orders}
      day={day}
      siteId={siteId}
      save={ownerUpdateCardMessage}
    />
  );
}
