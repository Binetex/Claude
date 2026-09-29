"use client";
import { useState, useTransition } from "react";
import { Plus } from "lucide-react";
import { toast } from "sonner";
import { ownerAddSurcharge } from "@/app/dashboard/(owner)/actions";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

/**
 * Доплата к заказу: клиент в последний момент решил доплатить — например, за другой букет
 * (владелец 29.09.2026). Сумма уходит в «Сумму товаров» и итог заказчика, а что изменилось —
 * в заметку заказа и флористу. Цену флористу за букет дороже правят отдельно, в «Цене флористу».
 */
export function SurchargeDialog({ orderId, customerTotal, hasFlorist }: { orderId: string; customerTotal: number; hasFlorist: boolean }) {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [notify, setNotify] = useState(true);
  const [pending, start] = useTransition();

  // Поля — заново при каждом открытии: брошенные числа не должны уйти следующим «Сохранить».
  function openDialog() {
    setAmount("");
    setNote("");
    setNotify(true);
    setOpen(true);
  }

  const n = Number(amount.replace(",", "."));
  const sum = Number.isFinite(n) ? Math.round(n * 100) / 100 : NaN;
  const ready = Number.isFinite(sum) && sum > 0 && note.trim().length > 0;

  function submit() {
    start(async () => {
      const res = await ownerAddSurcharge(orderId, { amount: sum, note, notifyFlorist: hasFlorist && notify });
      if (res.error) {
        toast.error(res.error);
        return;
      }
      toast.success(hasFlorist && notify ? "Доплата записана, флористу написали" : "Доплата записана");
      setOpen(false);
    });
  }

  return (
    <>
      <button type="button" onClick={openDialog} className="inline-flex items-center gap-1 text-xs font-medium text-slate-500 hover:text-slate-800" title="Клиент доплатил">
        <Plus className="h-3.5 w-3.5" />
        Доплата
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Доплата к заказу</DialogTitle></DialogHeader>

          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="surcharge-amount">Сколько доплатил клиент, USD</Label>
              <Input id="surcharge-amount" inputMode="decimal" placeholder="60" value={amount} onChange={(e) => setAmount(e.target.value)} className="max-w-[180px]" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="surcharge-note">Что изменилось — увидит флорист (без суммы)</Label>
              <Textarea
                id="surcharge-note"
                rows={3}
                maxLength={300}
                placeholder="Вместо Golden Chestnut — Red Roses & Vase, большой"
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            </div>
            {hasFlorist && (
              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} />
                Написать флористу в Telegram
              </label>
            )}
            <div className="rounded-md bg-slate-50 px-3 py-2 text-sm">
              Итог заказчика станет:{" "}
              <span className="font-semibold text-slate-900">{Number.isFinite(sum) && sum > 0 ? `$${(customerTotal + sum).toFixed(2)}` : "—"}</span>
              <div className="mt-1 text-xs text-slate-500">Цена флористу не меняется — за букет дороже поправьте её в «Цене флористу».</div>
            </div>
          </div>

          <div className="mt-3 flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={pending}>Отмена</Button>
            <Button type="button" onClick={submit} disabled={pending || !ready}>
              {pending ? "Сохранение…" : "Записать доплату"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
