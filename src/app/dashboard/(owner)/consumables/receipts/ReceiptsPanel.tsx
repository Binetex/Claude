"use client";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Card, CardHeader, CardTitle, CardBody } from "@/components/ui/Card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/states";
import { PackagePlus } from "lucide-react";
import { ownerAddConsumableReceipt, ownerUpdateConsumableReceipt, ownerDeleteConsumableReceipt } from "../actions";

export type ReceiptRow = {
  id: string;
  itemId: string;
  itemName: string;
  imageUrl: string | null;
  day: string;
  quantity: number;
  note: string | null;
};

/**
 * Приход: добавление и ПРАВКА записи. Раньше ошибку можно было только удалить и завести заново —
 * при живом остатке это лишний шаг и лишний риск промахнуться.
 */
export function ReceiptsPanel({ items, receipts }: { items: { id: string; name: string; imageUrl: string | null }[]; receipts: ReceiptRow[] }) {
  const [itemId, setItemId] = useState(items[0]?.id ?? "");
  const [day, setDay] = useState("");
  const [quantity, setQuantity] = useState("");
  const [note, setNote] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<ReceiptRow | null>(null);
  const [pending, start] = useTransition();

  function beginEdit(r: ReceiptRow) {
    setEditing(r.id);
    setDraft({ ...r });
  }

  return (
    <Card>
      <CardHeader className="py-2.5"><CardTitle icon={PackagePlus}>Приход</CardTitle></CardHeader>
      <CardBody className="space-y-4">
        <div className="flex flex-wrap items-end gap-2 text-xs">
          <label className="flex flex-col gap-1">
            <span className="text-slate-500">Расходник</span>
            <Select value={itemId} onChange={(e) => setItemId(e.target.value)} wrapperClassName="w-48" className="h-9">
              {items.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
            </Select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-slate-500">Дата</span>
            <Input type="date" value={day} onChange={(e) => setDay(e.target.value)} className="h-9 w-36" />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-slate-500">Сколько</span>
            <Input inputMode="numeric" value={quantity} onChange={(e) => setQuantity(e.target.value)} placeholder="10" className="h-9 w-20 text-right" />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-slate-500">Заметка</span>
            <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="необязательно" className="h-9 w-56" />
          </label>
          <Button
            size="sm"
            disabled={pending || !itemId || !quantity.trim() || !day}
            onClick={() => start(async () => {
              const r = await ownerAddConsumableReceipt({ itemId, day, quantity: Number(quantity), note });
              setMsg(r.error ?? r.message ?? "Готово");
              if (!r.error) { setQuantity(""); setNote(""); }
            })}
          >
            Записать
          </Button>
          {msg && <span className="pb-2 text-slate-500">{msg}</span>}
        </div>

        {receipts.length === 0 ? (
          <EmptyState title="Прихода пока нет" description="Запишите закупку — и в таблице выше появится остаток." />
        ) : (
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
                {receipts.map((r) => {
                  const isEditing = editing === r.id && draft;
                  return (
                    <tr key={r.id} className="border-b border-slate-100">
                      <td className="px-2 py-1.5">
                        {isEditing ? (
                          <Input type="date" value={draft!.day} onChange={(e) => setDraft({ ...draft!, day: e.target.value })} className="h-8 w-32 text-xs" />
                        ) : (
                          <span className="tabular-nums text-slate-600">{r.day.split("-").reverse().join(".")}</span>
                        )}
                      </td>
                      <td className="px-2 py-1.5">
                        {isEditing ? (
                          <Select value={draft!.itemId} onChange={(e) => setDraft({ ...draft!, itemId: e.target.value })} wrapperClassName="w-44" className="h-8 text-xs">
                            {items.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
                          </Select>
                        ) : (
                          <span className="flex items-center gap-1.5">
                            {r.imageUrl && (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img src={r.imageUrl} alt="" className="size-6 rounded object-cover" />
                            )}
                            {r.itemName}
                          </span>
                        )}
                      </td>
                      <td className="px-2 py-1.5 text-right">
                        {isEditing ? (
                          <Input
                            inputMode="numeric"
                            value={String(draft!.quantity)}
                            onChange={(e) => setDraft({ ...draft!, quantity: Number(e.target.value) || 0 })}
                            className="h-8 w-16 text-right text-xs tabular-nums"
                          />
                        ) : (
                          <span className="tabular-nums">{r.quantity}</span>
                        )}
                      </td>
                      <td className="px-2 py-1.5">
                        {isEditing ? (
                          <Input value={draft!.note ?? ""} onChange={(e) => setDraft({ ...draft!, note: e.target.value })} className="h-8 w-56 text-xs" />
                        ) : (
                          <span className="text-slate-500">{r.note ?? ""}</span>
                        )}
                      </td>
                      <td className="px-2 py-1.5 text-right whitespace-nowrap">
                        {isEditing ? (
                          <>
                            <Button
                              size="sm"
                              disabled={pending}
                              onClick={() => start(async () => {
                                const res = await ownerUpdateConsumableReceipt({
                                  id: draft!.id, itemId: draft!.itemId, day: draft!.day, quantity: draft!.quantity, note: draft!.note ?? "",
                                });
                                setMsg(res.error ?? res.message ?? "Готово");
                                if (!res.error) { setEditing(null); setDraft(null); }
                              })}
                            >
                              Сохранить
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => { setEditing(null); setDraft(null); }}>Отмена</Button>
                          </>
                        ) : (
                          <>
                            <Button size="sm" variant="ghost" onClick={() => beginEdit(r)}>изменить</Button>
                            <ConfirmDialog
                              trigger={<Button size="sm" variant="ghost">удалить</Button>}
                              title="Удалить запись прихода?"
                              description="Остаток пересчитается сразу."
                              confirmLabel="Удалить"
                              destructive
                              onConfirm={() => start(async () => { await ownerDeleteConsumableReceipt(r.id); })}
                            />
                          </>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </CardBody>
    </Card>
  );
}
