"use client";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Card, CardHeader, CardTitle, CardBody } from "@/components/ui/Card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/states";
import { ArrowRightLeft, History, PackagePlus } from "lucide-react";
import {
  ownerAddConsumableReceipt,
  ownerUpdateConsumableReceipt,
  ownerDeleteConsumableReceipt,
  ownerAddConsumableTransfer,
  ownerDeleteConsumableTransfer,
} from "../actions";

type Base = { id: string; itemId: string; itemName: string; imageUrl: string | null; day: string; quantity: number; note: string | null };

export type HistoryRow =
  | (Base & { kind: "receipt"; floristId: string | null; floristName: string | null })
  /** Передача между флористами: `id` — общий id двух строк, `quantity` — сколько передано. */
  | (Base & { kind: "transfer"; fromId: string | null; toId: string | null; fromName: string; toName: string });

type Option = { id: string; name: string };
type Draft = { id: string; itemId: string; floristId: string; day: string; quantity: string; note: string };

/**
 * Приход, передача между флористами и история. Флорист, выбранный в разделе, подставлен в формы:
 * открыли Ольгу — приход по умолчанию ей, передача — от неё.
 */
export function ReceiptsPanel({
  items,
  florists,
  selectedFloristId,
  today,
  rows,
}: {
  items: Option[];
  florists: Option[];
  selectedFloristId: string | null;
  today: string;
  rows: HistoryRow[];
}) {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const defaultFlorist = selectedFloristId ?? florists[0]?.id ?? "";

  // Приход.
  const [rItem, setRItem] = useState(items[0]?.id ?? "");
  const [rFlorist, setRFlorist] = useState(defaultFlorist);
  const [rDay, setRDay] = useState(today);
  const [rQty, setRQty] = useState("");
  const [rNote, setRNote] = useState("");

  // Передача.
  const [tItem, setTItem] = useState(items[0]?.id ?? "");
  const [tFrom, setTFrom] = useState(defaultFlorist);
  const [tTo, setTTo] = useState(florists.find((f) => f.id !== defaultFlorist)?.id ?? "");
  const [tDay, setTDay] = useState(today);
  const [tQty, setTQty] = useState("");
  const [tNote, setTNote] = useState("");

  const [draft, setDraft] = useState<Draft | null>(null);

  const run = (fn: () => Promise<{ error?: string; message?: string }>, onOk?: () => void) =>
    start(async () => {
      const r = await fn();
      setMsg(r.error ?? r.message ?? "Готово");
      if (!r.error) onOk?.();
    });

  const field = "flex flex-col gap-1";
  const label = "text-slate-500";

  return (
    <div className="space-y-4">
      {msg && <div className="text-xs text-slate-500">{msg}</div>}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="py-2.5"><CardTitle icon={PackagePlus}>Приход</CardTitle></CardHeader>
          <CardBody>
            <div className="flex flex-wrap items-end gap-2 text-xs">
              <label className={field}>
                <span className={label}>Расходник</span>
                <Select value={rItem} onChange={(e) => setRItem(e.target.value)} wrapperClassName="w-44" className="h-9">
                  {items.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
                </Select>
              </label>
              <label className={field}>
                <span className={label}>Кому пришло</span>
                <Select value={rFlorist} onChange={(e) => setRFlorist(e.target.value)} wrapperClassName="w-32" className="h-9">
                  {florists.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
                </Select>
              </label>
              <label className={field}>
                <span className={label}>Сколько</span>
                <Input inputMode="numeric" value={rQty} onChange={(e) => setRQty(e.target.value)} placeholder="500" className="h-9 w-20 text-right" />
              </label>
              <label className={field}>
                <span className={label}>Дата</span>
                <Input type="date" value={rDay} onChange={(e) => setRDay(e.target.value)} className="h-9 w-36" />
              </label>
              <label className={field}>
                <span className={label}>Заметка</span>
                <Input value={rNote} onChange={(e) => setRNote(e.target.value)} placeholder="из Китая, инвентаризация…" className="h-9 w-44" />
              </label>
              <Button
                size="sm"
                disabled={pending || !rItem || !rFlorist || !rQty.trim() || !rDay}
                onClick={() =>
                  run(
                    () => ownerAddConsumableReceipt({ itemId: rItem, floristId: rFlorist, day: rDay, quantity: Number(rQty), note: rNote }),
                    () => { setRQty(""); setRNote(""); }
                  )
                }
              >
                Записать
              </Button>
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader className="py-2.5"><CardTitle icon={ArrowRightLeft}>Передать другому флористу</CardTitle></CardHeader>
          <CardBody>
            <div className="flex flex-wrap items-end gap-2 text-xs">
              <label className={field}>
                <span className={label}>Расходник</span>
                <Select value={tItem} onChange={(e) => setTItem(e.target.value)} wrapperClassName="w-44" className="h-9">
                  {items.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
                </Select>
              </label>
              <label className={field}>
                <span className={label}>Кто передал</span>
                <Select value={tFrom} onChange={(e) => setTFrom(e.target.value)} wrapperClassName="w-32" className="h-9">
                  {florists.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
                </Select>
              </label>
              <label className={field}>
                <span className={label}>Кому</span>
                <Select value={tTo} onChange={(e) => setTTo(e.target.value)} wrapperClassName="w-32" className="h-9">
                  {florists.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
                </Select>
              </label>
              <label className={field}>
                <span className={label}>Сколько</span>
                <Input inputMode="numeric" value={tQty} onChange={(e) => setTQty(e.target.value)} placeholder="200" className="h-9 w-20 text-right" />
              </label>
              <label className={field}>
                <span className={label}>Дата</span>
                <Input type="date" value={tDay} onChange={(e) => setTDay(e.target.value)} className="h-9 w-36" />
              </label>
              <label className={field}>
                <span className={label}>Заметка</span>
                <Input value={tNote} onChange={(e) => setTNote(e.target.value)} placeholder="необязательно" className="h-9 w-36" />
              </label>
              <Button
                size="sm"
                disabled={pending || !tItem || !tFrom || !tTo || tFrom === tTo || !tQty.trim() || !tDay}
                onClick={() =>
                  run(
                    () => ownerAddConsumableTransfer({ itemId: tItem, fromFloristId: tFrom, toFloristId: tTo, day: tDay, quantity: Number(tQty), note: tNote }),
                    () => { setTQty(""); setTNote(""); }
                  )
                }
              >
                Передать
              </Button>
            </div>
            {tFrom && tFrom === tTo && <p className="mt-2 text-xs text-amber-700">Выберите другого флориста в «Кому».</p>}
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader className="py-2.5"><CardTitle icon={History}>История</CardTitle></CardHeader>
        <CardBody>
          {rows.length === 0 ? (
            <EmptyState title="Записей пока нет" description="Запишите приход — и в таблице выше появится остаток." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="border-b border-slate-200 text-slate-500">
                  <tr>
                    <th className="px-2 py-1.5 text-left font-medium">Дата</th>
                    <th className="px-2 py-1.5 text-left font-medium">Расходник</th>
                    <th className="px-2 py-1.5 text-left font-medium">Кому / передача</th>
                    <th className="px-2 py-1.5 text-right font-medium">Сколько</th>
                    <th className="px-2 py-1.5 text-left font-medium">Заметка</th>
                    <th className="px-2 py-1.5" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const editing = r.kind === "receipt" && draft?.id === r.id ? draft : null;
                    return (
                      <tr key={`${r.kind}:${r.id}`} className="border-b border-slate-100">
                        <td className="px-2 py-1.5">
                          {editing ? (
                            <Input type="date" value={editing.day} onChange={(e) => setDraft({ ...editing, day: e.target.value })} className="h-8 w-32 text-xs" />
                          ) : (
                            <span className="tabular-nums text-slate-600">{r.day.split("-").reverse().join(".")}</span>
                          )}
                        </td>
                        <td className="px-2 py-1.5">
                          {editing ? (
                            <Select value={editing.itemId} onChange={(e) => setDraft({ ...editing, itemId: e.target.value })} wrapperClassName="w-40" className="h-8 text-xs">
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
                        <td className="px-2 py-1.5">
                          {r.kind === "transfer" ? (
                            <span className="text-slate-700">{r.fromName} → {r.toName}</span>
                          ) : editing ? (
                            <Select value={editing.floristId} onChange={(e) => setDraft({ ...editing, floristId: e.target.value })} wrapperClassName="w-32" className="h-8 text-xs">
                              {!editing.floristId && <option value="">выберите</option>}
                              {florists.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
                            </Select>
                          ) : r.floristName ? (
                            <span className="text-slate-700">приход → {r.floristName}</span>
                          ) : (
                            <span className="text-amber-700">без флориста — «изменить», чтобы отметить кому</span>
                          )}
                        </td>
                        <td className="px-2 py-1.5 text-right">
                          {editing ? (
                            <Input inputMode="numeric" value={editing.quantity} onChange={(e) => setDraft({ ...editing, quantity: e.target.value })} className="h-8 w-16 text-right text-xs tabular-nums" />
                          ) : (
                            <span className="tabular-nums">{r.quantity}</span>
                          )}
                        </td>
                        <td className="px-2 py-1.5">
                          {editing ? (
                            <Input value={editing.note} onChange={(e) => setDraft({ ...editing, note: e.target.value })} className="h-8 w-44 text-xs" />
                          ) : (
                            <span className="text-slate-500">{r.note ?? ""}</span>
                          )}
                        </td>
                        <td className="px-2 py-1.5 text-right whitespace-nowrap">
                          {editing ? (
                            <>
                              <Button
                                size="sm"
                                disabled={pending || !editing.floristId}
                                onClick={() =>
                                  run(
                                    () =>
                                      ownerUpdateConsumableReceipt({
                                        id: editing.id, itemId: editing.itemId, floristId: editing.floristId, day: editing.day, quantity: Number(editing.quantity), note: editing.note,
                                      }),
                                    () => setDraft(null)
                                  )
                                }
                              >
                                Сохранить
                              </Button>
                              <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>Отмена</Button>
                            </>
                          ) : r.kind === "receipt" ? (
                            <>
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => setDraft({ id: r.id, itemId: r.itemId, floristId: r.floristId ?? "", day: r.day, quantity: String(r.quantity), note: r.note ?? "" })}
                              >
                                изменить
                              </Button>
                              <ConfirmDialog
                                trigger={<Button size="sm" variant="ghost">удалить</Button>}
                                title="Удалить запись прихода?"
                                description="Остаток пересчитается сразу."
                                confirmLabel="Удалить"
                                destructive
                                onConfirm={() => run(() => ownerDeleteConsumableReceipt(r.id))}
                              />
                            </>
                          ) : (
                            <ConfirmDialog
                              trigger={<Button size="sm" variant="ghost">удалить</Button>}
                              title="Удалить передачу?"
                              description={`${r.fromName} → ${r.toName}, ${r.quantity} шт. Остаток обоих пересчитается сразу.`}
                              confirmLabel="Удалить"
                              destructive
                              onConfirm={() => run(() => ownerDeleteConsumableTransfer(r.id))}
                            />
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
    </div>
  );
}
