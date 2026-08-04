"use client";
import { useState, useTransition } from "react";
import { Pencil } from "lucide-react";
import { toast } from "sonner";
import { ownerSetManualPrice } from "@/app/dashboard/(owner)/actions";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tooltip } from "@/components/ui/tooltip";

/**
 * Ручная цена флориста. Иконка-карандаш стоит прямо на плашке с ценой, поля — в модалке:
 * действие редкое, и отдельная карточка под одно поле занимала треть колонки управления.
 *
 * Контролируемый диалог, а не DialogTrigger: закрывать его нужно из submit по успеху.
 */
export function OwnerPriceDialog({ orderId, current }: { orderId: string; current: number }) {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState(String(current));
  const [pending, start] = useTransition();

  function submit() {
    start(async () => {
      await ownerSetManualPrice(orderId, Number(amount));
      toast.success("Цена задана");
      setOpen(false);
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Tooltip content="Задать цену флориста вручную">
        <span>
          <Button
            variant="ghost"
            size="iconSm"
            aria-label="Задать цену флориста вручную"
            onClick={() => setOpen(true)}
            className="text-slate-400 hover:bg-slate-800 hover:text-white"
          >
            <Pencil className="size-3.5" />
          </Button>
        </span>
      </Tooltip>
      <DialogContent>
        <DialogHeader><DialogTitle>Цена флориста</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="manual-price">Сумма</Label>
            <Input
              id="manual-price"
              type="number"
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
            <p className="text-xs text-slate-500">
              Заданная здесь сумма переводит заказ в ручной режим: авто-цена его больше не пересчитает.
            </p>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" disabled={pending} onClick={() => setOpen(false)}>Отмена</Button>
            <Button disabled={pending} onClick={submit}>{pending ? "Сохраняем…" : "Задать"}</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
