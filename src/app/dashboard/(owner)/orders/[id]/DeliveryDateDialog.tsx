"use client";
import { useState } from "react";
import { Pencil } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tooltip } from "@/components/ui/tooltip";
import { useBlockSave, ConflictNotice } from "./orderEditShared";

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
  deliveryWindow,
}: {
  orderId: string;
  updatedAt: string;
  deliveryDate: string;
  deliveryWindow: string;
}) {
  const [open, setOpen] = useState(false);
  const [d, setD] = useState(deliveryDate);
  const [w, setW] = useState(deliveryWindow);
  const { pending, conflict, save, acceptCurrentVersion } = useBlockSave(orderId, "delivery", updatedAt);

  function submit() {
    // Закрываем только по успеху: при конфликте модалка обязана остаться открытой,
    // иначе ConflictNotice негде показать.
    save(
      { deliveryDate: d, deliveryWindow: w },
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
            <Input value={w} onChange={(e) => setW(e.target.value)} className="mt-1" placeholder="12:00 – 16:00" />
          </div>
          {conflict && (
            <ConflictNotice
              current={conflict.current}
              labels={[{ k: "deliveryDate", label: "Дата" }, { k: "deliveryWindow", label: "Интервал" }]}
              onRefresh={() =>
                acceptCurrentVersion((c) => {
                  if ("deliveryDate" in c) setD(c.deliveryDate);
                  if ("deliveryWindow" in c) setW(c.deliveryWindow);
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
