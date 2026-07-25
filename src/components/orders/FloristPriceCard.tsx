import { Card, CardBody } from "@/components/ui/Card";
import { formatMoney } from "@/lib/money";

/**
 * Стоимость заказа для флориста — отдельным заметным блоком.
 * В широкой компоновке карточка уезжает в колонку управления, поэтому цена не должна
 * теряться среди прочих блоков: тёмная плашка, крупная сумма.
 */
export function FloristPriceCard({ floristTotal }: { floristTotal: number }) {
  return (
    <Card className="overflow-hidden">
      <CardBody className="bg-slate-800 px-4 py-3 text-center">
        <div className="text-xs text-slate-300">Ваша цена изготовления</div>
        <div className="text-2xl font-bold text-white">{formatMoney(floristTotal)}</div>
      </CardBody>
    </Card>
  );
}

/** Быстрые действия флориста: карта и звонок получателю. */
export function FloristQuickActions({ mapsUrl, recipientPhone }: { mapsUrl: string; recipientPhone: string | null }) {
  return (
    <div className="grid grid-cols-2 gap-2">
      <a
        href={mapsUrl}
        target="_blank"
        rel="noreferrer"
        className="rounded-lg border border-slate-300 bg-white py-2.5 text-center text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50"
      >
        🗺 Google Maps
      </a>
      <a
        href={`tel:${recipientPhone ?? ""}`}
        className="rounded-lg border border-slate-300 bg-white py-2.5 text-center text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50"
      >
        📞 Позвонить
      </a>
    </div>
  );
}
