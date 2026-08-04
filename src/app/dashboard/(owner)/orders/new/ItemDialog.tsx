"use client";
import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select } from "@/components/ui/select";
import type { DraftItem } from "./itemTypes";

/**
 * Одна форма и на свою позицию, и на правку любой строки заказа.
 *
 * У позиции ИЗ КАТАЛОГА название и вариант не редактируются: это снимок каталога, и менять
 * его руками значило бы получить строку, которая уже ни на что в каталоге не похожа. Менять
 * можно только то, что относится к этому заказу — количество, цены и состав. Каталог при
 * этом не меняется ни в каком случае.
 *
 * Финансовый тип и закупка спрятаны в <details>: обычный букет их не требует, а спрашивать
 * классификацию у каждого заказа — верный способ заставить людей выбирать наугад.
 */
export function ItemDialog({
  item,
  open,
  onOpenChange,
  onSave,
}: {
  item: DraftItem;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSave: (item: DraftItem) => void;
}) {
  const [draft, setDraft] = useState<DraftItem>(item);
  const isCatalog = draft.kind === "catalog";
  const set = <K extends keyof DraftItem>(k: K, v: DraftItem[K]) => setDraft((d) => ({ ...d, [k]: v }));

  const num = (v: string) => {
    const n = Number(v.replace(",", "."));
    return Number.isFinite(n) && n >= 0 ? n : 0;
  };

  function submit() {
    if (!isCatalog && !draft.name.trim()) return;
    onSave({ ...draft, name: draft.name.trim() });
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isCatalog ? "Позиция заказа" : draft.name ? "Своя позиция" : "Добавить свою позицию"}</DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          {isCatalog ? (
            <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm">
              <div className="font-medium break-words text-slate-800">{draft.name}</div>
              {draft.variantName && <div className="text-slate-500">{draft.variantName}</div>}
              <div className="mt-1 text-[11px] text-slate-400">
                Название и вариант — снимок каталога. Правки ниже действуют только в этом заказе.
              </div>
            </div>
          ) : (
            <div className="space-y-1.5">
              <Label htmlFor="item-name">Название</Label>
              <Input
                id="item-name"
                value={draft.name}
                onChange={(e) => set("name", e.target.value)}
                placeholder="Авторский букет"
                required
              />
            </div>
          )}

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="item-qty">Количество</Label>
              <Input
                id="item-qty"
                type="number"
                min={1}
                step={1}
                value={draft.quantity}
                onChange={(e) => set("quantity", Math.max(1, Math.round(num(e.target.value)) || 1))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="item-customer">Цена клиента</Label>
              <Input
                id="item-customer"
                inputMode="decimal"
                value={String(draft.customerPrice)}
                onChange={(e) => set("customerPrice", num(e.target.value))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="item-florist">Цена флориста</Label>
              <Input
                id="item-florist"
                inputMode="decimal"
                value={String(draft.floristPrice)}
                onChange={(e) => set("floristPrice", num(e.target.value))}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="item-comp">Состав или примечание</Label>
            <Textarea
              id="item-comp"
              rows={3}
              value={draft.composition ?? ""}
              onChange={(e) => set("composition", e.target.value)}
              placeholder="24 белые розы, 5 веток эвкалипта…"
            />
          </div>

          {!isCatalog && (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="item-image">Ссылка на изображение</Label>
                <Input
                  id="item-image"
                  value={draft.image ?? ""}
                  onChange={(e) => set("image", e.target.value.trim() || null)}
                  placeholder="необязательно"
                />
              </div>

              {/* Редкое — под раскрывашкой. <details> вместо Collapsible: он уже используется
                  в открытке и панели Burq, новой зависимости ради него не нужно. */}
              <details className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                <summary className="cursor-pointer text-sm font-medium text-slate-700">Дополнительно</summary>
                <div className="mt-3 space-y-3">
                  <p className="text-[11px] text-slate-500">
                    По умолчанию позиция считается обычным цветочным товаром. Заполняйте, только если это
                    ваза или подарок со своей закупочной стоимостью — она нужна расчёту прибыли дня.
                  </p>
                  <div className="space-y-1.5">
                    <Label htmlFor="item-type">Тип позиции</Label>
                    <Select
                      id="item-type"
                      value={draft.financialType ?? ""}
                      onChange={(e) => set("financialType", (e.target.value || null) as DraftItem["financialType"])}
                    >
                      <option value="">Цветочный товар (по умолчанию)</option>
                      <option value="VASE">Ваза</option>
                      <option value="SERVICE_FEE">Подарок или доп. услуга</option>
                      <option value="DELIVERY">Доставка</option>
                      <option value="TIP">Чаевые</option>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="item-cost">Закупочная стоимость, $</Label>
                    <Input
                      id="item-cost"
                      inputMode="decimal"
                      value={draft.purchaseCostCents == null ? "" : String(draft.purchaseCostCents / 100)}
                      onChange={(e) =>
                        set("purchaseCostCents", e.target.value.trim() === "" ? null : Math.round(num(e.target.value) * 100))
                      }
                      placeholder="не указана"
                    />
                  </div>
                </div>
              </details>
            </>
          )}

          <div className="flex flex-wrap justify-end gap-2 pt-1">
            <Button variant="outline" onClick={() => onOpenChange(false)}>Отмена</Button>
            <Button onClick={submit} disabled={!isCatalog && !draft.name.trim()}>Готово</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
