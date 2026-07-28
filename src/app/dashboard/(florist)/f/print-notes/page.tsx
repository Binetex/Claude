import { requireFlorist } from "@/lib/rbac";
import { loadPrintableCards } from "@/modules/print/loadPrintable";
import { floristUpdateCardMessage } from "../../actions";
import { PrintNotesPage, parsePrintDay } from "@/components/print/PrintNotesPage";

/** Вкладка флориста: печать записок на сегодня или завтра — только назначенные ему заказы. */
export const dynamic = "force-dynamic";

export default async function FloristPrintNotes({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const user = await requireFlorist();
  const sp = await searchParams;
  const siteId = sp.siteId?.trim() || undefined;
  const day = parsePrintDay(sp.day);

  // includeBlank: показываем и заказы без текста, чтобы флорист мог его добавить.
  // Массовая печать при этом берёт только заказы с текстом (см. loadPrintableCards).
  const orders = await loadPrintableCards(
    { role: user.role, floristId: user.floristId },
    { day, includeBlank: true, siteId }
  );

  return (
    <PrintNotesPage
      basePath="/dashboard/f/print-notes"
      title="Печать записок"
      orders={orders}
      day={day}
      siteId={siteId}
      save={floristUpdateCardMessage}
      backHref="/dashboard/f"
      backLabel="← Мои заказы"
    />
  );
}
