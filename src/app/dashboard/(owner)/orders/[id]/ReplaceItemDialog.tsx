"use client";
import { useState, useTransition } from "react";
import { Replace } from "lucide-react";
import { toast } from "sonner";
import { ownerReplaceOrderItem } from "@/app/dashboard/(owner)/actions";
import { CatalogPicker } from "@/components/orders/CatalogPicker";
import type { CatalogHit } from "@/modules/catalog/searchActions";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

/**
 * Замена букета в заказе на другой из каталога (владелец 30.09.2026): сначала выбор в каталоге
 * магазина заказа, потом подтверждение — цена клиенту за штуку (по умолчанию из каталога), состав
 * для флориста и новая карточка флористу. Разница цены уходит в итог заказчика.
 */
export function ReplaceItemDialog({
  orderId,
  itemId,
  site,
  current,
  customerTotal,
  florist,
}: {
  orderId: string;
  itemId: string;
  site: { id: string; name: string };
  current: { label: string; unitPrice: number; quantity: number };
  customerTotal: number;
  /** null — флорист не назначен: цена ему зафиксируется при назначении. */
  florist: { manualPrice: boolean } | null;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [hit, setHit] = useState<CatalogHit | null>(null);
  const [price, setPrice] = useState("");
  const [composition, setComposition] = useState("");
  const [notify, setNotify] = useState(true);
  const [pending, start] = useTransition();

  function onPick(h: CatalogHit) {
    setHit(h);
    setPrice(String(h.customerPrice));
    setComposition(h.composition ?? "");
    setNotify(true);
  }

  const n = Number(price.replace(",", "."));
  const unit = Number.isFinite(n) ? Math.round(n * 100) / 100 : NaN;
  const ok = !!hit && Number.isFinite(unit) && unit >= 0;
  const diff = ok ? (unit - current.unitPrice) * current.quantity : 0;
  const next = customerTotal + diff;

  function submit() {
    if (!hit) return;
    start(async () => {
      const res = await ownerReplaceOrderItem(orderId, itemId, {
        productId: hit.productId,
        variantId: hit.variantId,
        customerPrice: unit,
        composition: composition.trim() || null,
        notifyFlorist: !!florist && notify,
      });
      if (res.error) {
        toast.error(res.error);
        return;
      }
      toast.success(florist && notify ? "Букет заменён, флористу ушла новая карточка" : "Букет заменён");
      setHit(null);
    });
  }

  return (
    <>
      <button type="button" onClick={() => setPickerOpen(true)} className="inline-flex items-center gap-1 text-xs font-medium text-slate-500 hover:text-slate-800" title="Заменить букет на другой из каталога">
        <Replace className="h-3.5 w-3.5" />
        Заменить
      </button>

      <CatalogPicker sites={[site]} siteId={site.id} open={pickerOpen} onOpenChange={setPickerOpen} onPick={onPick} />

      <Dialog open={!!hit} onOpenChange={(v) => { if (!v) setHit(null); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>Заменить букет</DialogTitle></DialogHeader>
          {hit && (
            <div className="space-y-3">
              <div className="rounded-md bg-slate-50 px-3 py-2 text-sm">
                <div className="text-slate-500">Было: {current.label}</div>
                <div className="mt-1 flex items-center gap-3">
                  {hit.image ? (
                    // Обычный img: каталожные фото лежат на доменах магазинов (см. CatalogPicker).
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={hit.image} alt="" className="size-12 shrink-0 rounded object-cover" />
                  ) : null}
                  <span className="font-medium text-slate-900">Станет: {hit.productName}{hit.variantName ? `, ${hit.variantName}` : ""}</span>
                </div>
              </div>
              <div className="space-y-1">
                <Label htmlFor="replace-price">Цена клиенту за штуку, USD{current.quantity > 1 ? ` (×${current.quantity})` : ""}</Label>
                <Input id="replace-price" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} className="max-w-[180px]" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="replace-composition">Состав для флориста</Label>
                <Textarea id="replace-composition" rows={3} value={composition} onChange={(e) => setComposition(e.target.value)} />
              </div>
              {florist && (
                <label className="flex items-center gap-2 text-sm text-slate-700">
                  <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} />
                  Отправить флористу новую карточку с фото
                </label>
              )}
              <div className="rounded-md bg-slate-50 px-3 py-2 text-sm">
                Итог заказчика: ${customerTotal.toFixed(2)} → <span className="font-semibold text-slate-900">{ok ? `$${next.toFixed(2)}` : "—"}</span>
                {ok && diff !== 0 && <span className="text-slate-500"> ({diff > 0 ? "+" : "−"}${Math.abs(diff).toFixed(2)})</span>}
                <div className="mt-1 text-xs text-slate-500">
                  {!florist
                    ? "Цена флористу зафиксируется при назначении."
                    : florist.manualPrice
                      ? "Цена флористу задана вручную — если нужно, поправьте её в «Цене флористу»."
                      : "Цена флористу за эту позицию пересчитается по каталогу."}
                </div>
              </div>
              <div className="flex justify-end gap-2">
                <Button type="button" variant="ghost" onClick={() => setHit(null)} disabled={pending}>Отмена</Button>
                <Button type="button" onClick={submit} disabled={pending || !ok || (ok && next < 0)}>
                  {pending ? "Заменяю…" : "Заменить букет"}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
