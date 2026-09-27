"use client";
import { useState } from "react";
import { Pencil } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tooltip } from "@/components/ui/tooltip";
import { useBlockSave, ConflictNotice } from "./orderEditShared";
import { WindowPicker } from "@/components/orders/WindowPicker";
import { fmtHm, parseHm, parseWindowText, type WindowRange } from "@/lib/deliveryWindow";

/**
 * Правка даты и интервала доставки прямо из шапки заказа.
 *
 * Дата уже показана вверху страницы, поэтому отдельная карточка в колонке управления
 * повторяла те же два поля второй раз. Здесь иконка рядом с датой, а поля — в модалке.
 *
 * Путь сохранения тот же, что у карточки владельца: useBlockSave(orderId, "delivery") с OCC
 * и ConflictNotice. Второй реализации нет — правила и конфликты остаются едиными.
 */
export function DeliveryDateDialog({
  orderId,
  updatedAt,
  deliveryDate,
  window,
  presets,
}: {
  orderId: string;
  updatedAt: string;
  deliveryDate: string;
  /** Окно строго «с — до»; null — время не задано (старый текст не разобрался). */
  window: WindowRange | null;
  /** Частые окна магазина — кнопки в выборе времени. */
  presets: WindowRange[];
}) {
  const [open, setOpen] = useState(false);
  const [d, setD] = useState(deliveryDate);
  const [w, setW] = useState<WindowRange | null>(window);
  const { pending, conflict, save, acceptCurrentVersion } = useBlockSave(orderId, "delivery", updatedAt);

  function submit() {
    // Закрываем только по успеху: при конфликте модалка обязана остаться открытой,
    // иначе ConflictNotice негде показать.
    save(
      { deliveryDate: d, windowFrom: w ? fmtHm(w.from) : "", windowTo: w ? fmtHm(w.to) : "" },
      { successMessage: "Доставка обновлена", onOk: () => setOpen(false) }
    );
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {/* Контролируемый диалог, а не DialogTrigger: закрывать его нужно из submit по успеху
          сохранения (при конфликте модалка обязана остаться открытой), а это требует
          доступа к состоянию. Обёртка span — чтобы Tooltip цеплялся к ней, а не клонировал
          кнопку через Slot. */}
      <Tooltip content="Изменить дату и время">
        <span>
          <Button
            variant="ghost"
            size="iconSm"
            aria-label="Изменить дату и время доставки"
            onClick={() => setOpen(true)}
          >
            <Pencil className="size-3.5" />
          </Button>
        </span>
      </Tooltip>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Дата и время доставки</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>Дата</Label>
            <Input type="date" value={d} onChange={(e) => setD(e.target.value)} className="mt-1" />
          </div>
          <div>
            <Label>Интервал</Label>
            <div className="mt-1">
              <WindowPicker value={w} onChange={setW} presets={presets} disabled={pending} />
            </div>
          </div>
          {conflict && (
            <ConflictNotice
              current={conflict.current}
              labels={[{ k: "deliveryDate", label: "Дата" }, { k: "deliveryWindow", label: "Интервал" }]}
              onRefresh={() =>
                acceptCurrentVersion((c) => {
                  if ("deliveryDate" in c) setD(c.deliveryDate);
                  // Свежее окно: строгие поля, а у старого заказа — разбор текста.
                  const from = c.windowFrom ? Number(c.windowFrom) : null;
                  const to = c.windowTo ? Number(c.windowTo) : null;
                  setW(from != null && to != null && from < to ? { from, to } : parseWindowText(c.deliveryWindow) ?? parseHmRange(c.windowFrom, c.windowTo));
                })
              }
            />
          )}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setOpen(false)} disabled={pending}>
              Отмена
            </Button>
            <Button onClick={submit} disabled={pending}>
              {pending ? "Сохранение…" : "Сохранить"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Конфликт мог прийти со временем в виде «HH:MM» — тоже понимаем. */
function parseHmRange(from?: string, to?: string): WindowRange | null {
  const f = parseHm(from);
  const t = parseHm(to);
  return f != null && t != null && f < t ? { from: f, to: t } : null;
}
