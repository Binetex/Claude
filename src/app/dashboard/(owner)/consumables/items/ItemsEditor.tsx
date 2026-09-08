"use client";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ownerSaveConsumableItem, ownerArchiveConsumableItem } from "../actions";
import { VASE_KEYS, VASE_LABEL } from "@/modules/consumables/rules";

export type EditableItem = {
  id: string;
  name: string;
  siteId: string | null;
  autoRule: string | null;
  autoKey: string | null;
  imageUrl: string | null;
  sortOrder: number;
  archived: boolean;
};

/** Правила, которые умеет считать система. Список закрытый: за каждым стоит код. */
const RULES: { value: string; label: string }[] = [
  { value: "", label: "только руками" },
  { value: "VASE_TYPE", label: "ваза этого типа" },
  { value: "VASE_BOTTOM", label: "донышко (по числу ваз)" },
  { value: "CARE_GUIDE_VASE", label: "Care Guide для вазы" },
  { value: "CARE_GUIDE_BOUQUET", label: "Care Guide для букета" },
  { value: "BRANDED_ENVELOPE", label: "брендированный конверт (1 на заказ)" },
];

export function ItemsEditor({ items, sites }: { items: EditableItem[]; sites: { id: string; label: string }[] }) {
  const [rows, setRows] = useState(items);
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function patch(id: string, patchObj: Partial<EditableItem>) {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patchObj } : r)));
  }

  function save(row: EditableItem) {
    setMsg(null);
    start(async () => {
      const r = await ownerSaveConsumableItem({
        id: row.id, name: row.name, siteId: row.siteId, autoRule: row.autoRule,
        autoKey: row.autoKey, imageUrl: row.imageUrl, sortOrder: row.sortOrder,
      });
      setMsg(r.error ?? "Сохранено");
    });
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead className="border-b border-slate-200 bg-slate-50 text-slate-500">
          <tr>
            <th className="px-3 py-2 text-left font-medium">Вид</th>
            <th className="px-3 py-2 text-left font-medium">Название</th>
            <th className="px-2 py-2 text-left font-medium">Магазин</th>
            <th className="px-2 py-2 text-left font-medium">Считает система</th>
            <th className="px-2 py-2 text-left font-medium">Тип вазы</th>
            <th className="px-2 py-2 text-left font-medium">Ссылка на картинку</th>
            <th className="px-2 py-2 text-right font-medium">Порядок</th>
            <th className="px-2 py-2" />
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className={`border-b border-slate-100 ${row.archived ? "opacity-50" : ""}`}>
              <td className="px-3 py-1.5">
                {row.imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={row.imageUrl} alt="" className="size-10 rounded-lg object-cover" />
                ) : (
                  <div className="flex size-10 items-center justify-center rounded-lg bg-slate-100 text-[9px] text-slate-400">нет</div>
                )}
              </td>
              <td className="px-3 py-1.5">
                <Input
                  value={row.name}
                  onChange={(e) => patch(row.id, { name: e.target.value })}
                  onBlur={() => save(row)}
                  className="h-8 w-44 text-xs"
                />
              </td>
              <td className="px-2 py-1.5">
                <Select
                  value={row.siteId ?? ""}
                  onChange={(e) => { patch(row.id, { siteId: e.target.value || null }); }}
                  onBlur={() => save(row)}
                  wrapperClassName="w-36"
                  className="h-8 text-xs"
                >
                  <option value="">все магазины</option>
                  {sites.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
                </Select>
              </td>
              <td className="px-2 py-1.5">
                <Select
                  value={row.autoRule ?? ""}
                  onChange={(e) => patch(row.id, { autoRule: e.target.value || null })}
                  onBlur={() => save(row)}
                  wrapperClassName="w-56"
                  className="h-8 text-xs"
                >
                  {RULES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                </Select>
              </td>
              <td className="px-2 py-1.5">
                {row.autoRule === "VASE_TYPE" ? (
                  <Select
                    value={row.autoKey ?? ""}
                    onChange={(e) => patch(row.id, { autoKey: e.target.value || null })}
                    onBlur={() => save(row)}
                    wrapperClassName="w-40"
                    className="h-8 text-xs"
                  >
                    <option value="">выберите</option>
                    {VASE_KEYS.map((k) => <option key={k} value={k}>{VASE_LABEL[k]}</option>)}
                  </Select>
                ) : (
                  <span className="text-slate-300">—</span>
                )}
              </td>
              <td className="px-2 py-1.5">
                <Input
                  value={row.imageUrl ?? ""}
                  onChange={(e) => patch(row.id, { imageUrl: e.target.value || null })}
                  onBlur={() => save(row)}
                  placeholder="https://…"
                  className="h-8 w-44 text-xs"
                />
              </td>
              <td className="px-2 py-1.5 text-right">
                <Input
                  inputMode="numeric"
                  value={row.sortOrder}
                  onChange={(e) => patch(row.id, { sortOrder: Number(e.target.value) || 0 })}
                  onBlur={() => save(row)}
                  className="h-8 w-14 text-right text-xs tabular-nums"
                />
              </td>
              <td className="px-2 py-1.5 text-right">
                {row.archived ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={pending}
                    onClick={() => start(async () => {
                      await ownerArchiveConsumableItem(row.id, false);
                      patch(row.id, { archived: false });
                    })}
                  >
                    вернуть
                  </Button>
                ) : (
                  <ConfirmDialog
                    trigger={<Button type="button" size="sm" variant="ghost">убрать</Button>}
                    title="Убрать позицию из списка?"
                    description="Проставленные количества за прошлые дни сохранятся — позиция просто исчезнет из журнала."
                    confirmLabel="Убрать"
                    onConfirm={() => start(async () => {
                      await ownerArchiveConsumableItem(row.id, true);
                      patch(row.id, { archived: true });
                    })}
                  />
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {msg && <div className="px-3 py-2 text-xs text-slate-500">{msg}</div>}
    </div>
  );
}
