"use client";
import { useState, useTransition } from "react";
import { Pencil } from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogTrigger, DialogContent, DialogHeader, DialogTitle, DialogClose } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { ownerSetVariantFloristPrice, ownerSetVariantComposition } from "@/app/dashboard/(owner)/actions";

type Sibling = { id: string; label: string; composition: string | null };

/** Редактирование варианта — цена флориста + состав букета в одной модалке. */
export function VariantEditDialog({
  variantId,
  title,
  initialPrice,
  initialComposition,
  siblings,
  adminUrl,
}: {
  variantId: string;
  title: string;
  initialPrice: number | null;
  initialComposition: string | null;
  siblings: Sibling[];
  adminUrl: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [price, setPrice] = useState(initialPrice != null ? String(initialPrice) : "");
  const [comp, setComp] = useState(initialComposition ?? "");
  const [pending, start] = useTransition();

  function save() {
    start(async () => {
      const raw = price.trim();
      const amount = raw === "" ? null : Number(raw);
      await ownerSetVariantFloristPrice(variantId, amount != null && Number.isFinite(amount) && amount >= 0 ? amount : null);
      await ownerSetVariantComposition(variantId, comp.trim() ? comp : null);
      toast.success("Вариант сохранён");
      setOpen(false);
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Pencil />
          Редактировать
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Вариант: {title}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>Цена флориста</Label>
            <Input
              type="number"
              step="0.01"
              min="0"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              placeholder="Full Price (не задана)"
              className="mt-1"
            />
            <p className="mt-1 text-xs text-slate-400">Пусто = полная стоимость заказа.</p>
          </div>
          <div>
            <div className="mb-1 flex items-center justify-between">
              <Label>Состав букета</Label>
              {siblings.length > 0 && (
                <select
                  defaultValue=""
                  onChange={(e) => {
                    const s = siblings.find((x) => x.id === e.target.value);
                    if (s) setComp(s.composition ?? "");
                    e.currentTarget.value = "";
                  }}
                  className="rounded-md border border-slate-200 px-1.5 py-0.5 text-xs text-slate-600"
                >
                  <option value="" disabled>Копировать из…</option>
                  {siblings.map((s) => (
                    <option key={s.id} value={s.id}>{s.label}{s.composition ? "" : " (пусто)"}</option>
                  ))}
                </select>
              )}
            </div>
            <Textarea value={comp} onChange={(e) => setComp(e.target.value)} rows={5} placeholder={"24 white roses\n5 eucalyptus stems\n1 vase"} />
          </div>
        </div>
        <div className="mt-4 flex items-center justify-between">
          {adminUrl ? (
            <a href={adminUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-slate-500 hover:text-slate-800">
              Открыть в Shopify ↗
            </a>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <DialogClose asChild>
              <Button variant="ghost" size="sm">Отмена</Button>
            </DialogClose>
            <Button size="sm" disabled={pending} onClick={save}>
              {pending ? "Сохранение…" : "Сохранить"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
