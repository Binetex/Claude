"use client";
import { useState } from "react";
import { Pencil } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tooltip } from "@/components/ui/tooltip";
import { useBlockSave } from "./orderEditShared";
import { WindowPicker } from "@/components/orders/WindowPicker";
import { fmtHm, type WindowRange } from "@/lib/deliveryWindow";
import type { BlockFormData } from "@/modules/orders/updateOrderBlock";

/**
 * Правка даты и интервала доставки прямо из шапки заказа.
 *
 * Дата уже показана вверху страницы, поэтому отдельная карточка в колонке управления
 * повторяла те же два поля второй раз. Здесь иконка рядом с датой, а поля — в модалке.
 *
 * Путь сохранения тот же, что у карточки владельца: useBlockSave(orderId, "delivery"). Второй
 * реализации нет. Уходит только изменённое: поменяли время — дата не перепишется копией,
 * снятой при открытии (её мог за это время перенести ИИ по словам клиента).
 */
export function DeliveryDateDialog({
  orderId,
  deliveryDate,
  window,
  presets,
}: {
  orderId: string;
  deliveryDate: string;
  /** Окно строго «с — до»; null — время не задано (старый текст не разобрался). */
  window: WindowRange | null;
  /** Частые окна магазина — кнопки в выборе времени. */
  presets: WindowRange[];
}) {
  const [open, setOpen] = useState(false);
  const [d, setD] = useState(deliveryDate);
  const [w, setW] = useState<WindowRange | null>(window);
  // Что было при открытии — с этим сравниваем, чтобы отправить только изменённое.
  const [base, setBase] = useState<{ d: string; w: WindowRange | null }>({ d: deliveryDate, w: window });
  const { pending, save } = useBlockSave(orderId, "delivery");

  /** Открыли — в полях текущие дата и время заказа, а не оставшиеся с прошлого открытия. */
  function openDialog() {
    setD(deliveryDate);
    setW(window);
    setBase({ d: deliveryDate, w: window });
    setOpen(true);
  }

  function submit() {
    const data: BlockFormData = {};
    if (d !== base.d) data.deliveryDate = d;
    if (w?.from !== base.w?.from || w?.to !== base.w?.to) {
      data.windowFrom = w ? fmtHm(w.from) : "";
      data.windowTo = w ? fmtHm(w.to) : "";
    }
    if (Object.keys(data).length === 0) {
      setOpen(false); // ничего не меняли — сохранять нечего
      return;
    }
    // Закрываем только по успеху: при ошибке модалка остаётся открытой с введённым.
    save(data, { successMessage: "Доставка обновлена", onOk: () => setOpen(false) });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {/* Контролируемый диалог, а не DialogTrigger: закрывать его нужно из submit по успеху
          сохранения (при ошибке модалка остаётся открытой), а это требует доступа к
          состоянию. Обёртка span — чтобы Tooltip цеплялся к ней, а не клонировал
          кнопку через Slot. */}
      <Tooltip content="Изменить дату и время">
        <span>
          <Button
            variant="ghost"
            size="iconSm"
            aria-label="Изменить дату и время доставки"
            onClick={openDialog}
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
