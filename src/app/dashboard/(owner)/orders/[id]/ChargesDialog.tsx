"use client";
import { useState, useTransition } from "react";
import { Pencil } from "lucide-react";
import { toast } from "sonner";
import { ownerUpdateManualCharges } from "@/app/dashboard/(owner)/actions";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * Правка сумм ручного заказа. Карандаш стоит на карточке раскладки, поля — в модалке: действие
 * редкое, а под карточкой и так плотно.
 *
 * Итог заказчика НЕ вводится напрямую и не показывается полем ввода: он складывается из товаров
 * и этих четырёх сумм. Отдельное поле итога рассинхронизировалось бы с раскладкой, которая
 * нарисована прямо над ним, и экран противоречил бы сам себе. Предпросмотр итога считается тут же,
 * по той же формуле, что на сервере.
 */
const FIELDS = [
  { key: "tax", label: "Налог" },
  { key: "tip", label: "Чаевые" },
  { key: "deliveryCustomerCost", label: "Доставка (заказчик)" },
  { key: "discount", label: "Скидка" },
] as const;

type Values = Record<(typeof FIELDS)[number]["key"], string>;

export function ChargesDialog({
  orderId,
  itemsTotal,
  current,
}: {
  orderId: string;
  itemsTotal: number;
  current: { tax: number; tip: number; discount: number; deliveryCustomerCost: number };
}) {
  const [open, setOpen] = useState(false);
  const [v, setV] = useState<Values>({
    tax: String(current.tax),
    tip: String(current.tip),
    deliveryCustomerCost: String(current.deliveryCustomerCost),
    discount: String(current.discount),
  });
  const [pending, start] = useTransition();

  /**
   * Поля заполняются заново при КАЖДОМ открытии. Состояние клиентского компонента переживает
   * закрытие модалки, поэтому без этого «Отмена» ничего не отменяла: набранные и брошенные числа
   * оставались в полях, и следующее «Сохранить» применяло именно их.
   */
  function openDialog() {
    setV({
      tax: String(current.tax),
      tip: String(current.tip),
      deliveryCustomerCost: String(current.deliveryCustomerCost),
      discount: String(current.discount),
    });
    setOpen(true);
  }

  // Округляем до цента ЗДЕСЬ, а не только на сервере: иначе «10.005» дало бы в предпросмотре
  // один итог, а в базе — на цент другой, потому что сервер округляет каждое поле перед записью.
  const num = (s: string) => {
    const n = Number(s.replace(",", "."));
    return Number.isFinite(n) ? Math.round(n * 100) / 100 : NaN;
  };
  const parsed = {
    tax: num(v.tax),
    tip: num(v.tip),
    deliveryCustomerCost: num(v.deliveryCustomerCost),
    discount: num(v.discount),
  };
  const bad = Object.values(parsed).some((n) => !Number.isFinite(n) || n < 0);
  const total = itemsTotal + parsed.tax + parsed.tip + parsed.deliveryCustomerCost - parsed.discount;

  function submit() {
    start(async () => {
      const res = await ownerUpdateManualCharges(orderId, parsed);
      if (res.error) {
        toast.error(res.error);
        return;
      }
      toast.success("Суммы сохранены");
      setOpen(false);
    });
  }

  return (
    <>
      <button type="button" onClick={openDialog} className="text-slate-400 hover:text-slate-700" title="Изменить суммы">
        <Pencil className="h-3.5 w-3.5" />
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Суммы заказа</DialogTitle></DialogHeader>

          <div className="grid grid-cols-2 gap-3">
            {FIELDS.map((f) => (
              <div key={f.key} className="space-y-1">
                <Label htmlFor={f.key}>{f.label}</Label>
                <Input
                  id={f.key}
                  inputMode="decimal"
                  value={v[f.key]}
                  onChange={(e) => setV((s) => ({ ...s, [f.key]: e.target.value }))}
                />
              </div>
            ))}
          </div>

          <div className="mt-1 rounded-md bg-slate-50 px-3 py-2 text-sm">
            <div className="text-xs text-slate-500">Сумма товаров ${itemsTotal.toFixed(2)} — правится только в позициях заказа.</div>
            <div className="mt-1">
              Итог заказчика:{" "}
              <span className={bad || total < 0 ? "font-semibold text-red-600" : "font-semibold text-slate-900"}>
                {bad ? "—" : `$${total.toFixed(2)}`}
              </span>
            </div>
          </div>

          <div className="mt-3 flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={pending}>Отмена</Button>
            <Button type="button" onClick={submit} disabled={pending || bad || total < 0}>
              {pending ? "Сохранение…" : "Сохранить"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
