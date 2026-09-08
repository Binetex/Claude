"use client";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardBody } from "@/components/ui/Card";
import { PackagePlus } from "lucide-react";
import { ownerAddConsumableReceipt, ownerDeleteConsumableReceipt } from "../actions";

export type ReceiptRow = { id: string; itemName: string; day: string; quantity: number; note: string | null };

export function ReceiptsPanel({ items, receipts }: { items: { id: string; name: string }[]; receipts: ReceiptRow[] }) {
  const [itemId, setItemId] = useState(items[0]?.id ?? "");
  const [day, setDay] = useState(new Date().toISOString().slice(0, 10));
  const [quantity, setQuantity] = useState("");
  const [note, setNote] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();

  return (
    <Card>
      <CardHeader className="py-2.5"><CardTitle icon={PackagePlus}>Записать приход</CardTitle></CardHeader>
      <CardBody className="space-y-3">
        <div className="flex flex-wrap items-end gap-2 text-xs">
          <label className="flex flex-col gap-0.5">
            Расходник
            <select value={itemId} onChange={(e) => setItemId(e.target.value)} className="w-48 rounded border border-slate-300 px-2 py-1">
              {items.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-0.5">
            Дата
            <input type="date" value={day} onChange={(e) => setDay(e.target.value)} className="rounded border border-slate-300 px-2 py-1" />
          </label>
          <label className="flex flex-col gap-0.5">
            Сколько
            <input inputMode="numeric" value={quantity} onChange={(e) => setQuantity(e.target.value)} placeholder="10" className="w-20 rounded border border-slate-300 px-2 py-1 text-right" />
          </label>
          <label className="flex flex-col gap-0.5">
            Заметка
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="необязательно" className="w-56 rounded border border-slate-300 px-2 py-1" />
          </label>
          <Button
            size="sm"
            disabled={pending || !itemId || !quantity.trim()}
            onClick={() => start(async () => {
              const r = await ownerAddConsumableReceipt({ itemId, day, quantity: Number(quantity), note });
              setMsg(r.error ?? r.message ?? "Готово");
              if (!r.error) { setQuantity(""); setNote(""); }
            })}
          >
            Записать
          </Button>
          {msg && <span className="pb-1 text-slate-500">{msg}</span>}
        </div>

        {receipts.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="border-b border-slate-200 text-slate-500">
                <tr>
                  <th className="px-2 py-1.5 text-left font-medium">Дата</th>
                  <th className="px-2 py-1.5 text-left font-medium">Расходник</th>
                  <th className="px-2 py-1.5 text-right font-medium">Сколько</th>
                  <th className="px-2 py-1.5 text-left font-medium">Заметка</th>
                  <th className="px-2 py-1.5" />
                </tr>
              </thead>
              <tbody>
                {receipts.map((r) => (
                  <tr key={r.id} className="border-b border-slate-100">
                    <td className="px-2 py-1 tabular-nums text-slate-600">{r.day.split("-").reverse().join(".")}</td>
                    <td className="px-2 py-1">{r.itemName}</td>
                    <td className="px-2 py-1 text-right tabular-nums">{r.quantity}</td>
                    <td className="px-2 py-1 text-slate-500">{r.note ?? ""}</td>
                    <td className="px-2 py-1 text-right">
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disabled={pending}
                        onClick={() => start(async () => { await ownerDeleteConsumableReceipt(r.id); })}
                      >
                        удалить
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardBody>
    </Card>
  );
}
