"use client";
import { useState, useTransition } from "react";
import { Pencil } from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogTrigger, DialogContent, DialogHeader, DialogTitle, DialogClose } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useBlockSave } from "./orderEditShared";
import { checkUnlinkedComms, attachUnlinkedComms } from "@/modules/orders/editActions";

type FieldDef = { k: string; label: string; wide?: boolean };

const RECIPIENT_FIELDS: FieldDef[] = [
  { k: "recipientName", label: "Имя" },
  { k: "recipientPhone", label: "Телефон" },
  { k: "recipientEmail", label: "Email" },
  { k: "addressLine", label: "Адрес", wide: true },
  { k: "apartment", label: "Апартаменты" },
  { k: "city", label: "Город" },
  { k: "zip", label: "Индекс" },
];
const SENDER_FIELDS: FieldDef[] = [
  { k: "senderName", label: "Имя" },
  { k: "senderPhone", label: "Телефон" },
  { k: "senderEmail", label: "Email" },
];

/**
 * Иконка-редактирование на карточке «Отправитель»/«Получатель» → модалка с полями.
 * Единый путь сохранения: владелец/колл-центр/флорист. Показываются только те поля, что
 * переданы в `initial` (например, флористу отправитель отдаётся без email). Уходят ТОЛЬКО
 * изменённые поля: нетронутые не перетрутся копией, снятой при открытии.
 */
export function ContactEditDialog({
  kind,
  orderId,
  initial,
}: {
  kind: "recipient" | "sender";
  orderId: string;
  initial: Record<string, string>;
}) {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState<Record<string, string>>(initial);
  // Что было в полях при открытии — с этим сравниваем, чтобы отправить только изменённое.
  const [base, setBase] = useState<Record<string, string>>(initial);
  const [unlinked, setUnlinked] = useState<{ count: number } | null>(null);
  const [busy, startBusy] = useTransition();
  const block = kind === "recipient" ? "contacts" : "sender";
  const side = kind === "recipient" ? "RECIPIENT" : "CUSTOMER";
  const phoneKey = kind === "recipient" ? "recipientPhone" : "senderPhone";
  const { pending, save } = useBlockSave(orderId, block);

  const allFields = kind === "recipient" ? RECIPIENT_FIELDS : SENDER_FIELDS;
  const fields = allFields.filter((fl) => fl.k in initial);
  const title = kind === "recipient" ? "Получатель" : "Отправитель";

  /** Открыли — в полях текущие данные заказа, а не то, что осталось с прошлого открытия. */
  function onOpenChange(next: boolean) {
    if (next) {
      setF(initial);
      setBase(initial);
      setUnlinked(null);
    }
    setOpen(next);
  }

  function submit() {
    const data: Record<string, string> = {};
    for (const fl of fields) if ((f[fl.k] ?? "") !== (base[fl.k] ?? "")) data[fl.k] = f[fl.k] ?? "";
    if (Object.keys(data).length === 0) {
      setOpen(false); // ничего не меняли — сохранять нечего
      return;
    }
    const phoneChanged = phoneKey in data;
    // onOk не вызывается при ошибке сохранения → тогда ничего не ищем.
    save(data, {
      successMessage: `${title} обновлён`,
      onOk: () => {
        if (!phoneChanged) { setOpen(false); return; }
        // Телефон изменился — ищем непривязанную переписку по новому номеру (без QUO API).
        startBusy(async () => {
          const r = await checkUnlinkedComms(orderId, side);
          if (r.count > 0) setUnlinked({ count: r.count });
          else setOpen(false);
        });
      },
    });
  }

  function attach() {
    startBusy(async () => {
      const r = await attachUnlinkedComms(orderId, side);
      toast.success(r.attached > 0 ? `Привязано сообщений: ${r.attached}` : "Нечего привязывать");
      setUnlinked(null);
      setOpen(false);
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="iconSm" title="Редактировать">
          <Pencil />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Редактировать: {title.toLowerCase()}</DialogTitle>
        </DialogHeader>
        {/* На телефоне поля в один столбец: на 320px половинка модалки — это ~118px, в которые
            не помещается ни адрес, ни email. */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {fields.map((fl) => (
            <div key={fl.k} className={fl.wide ? "sm:col-span-2" : ""}>
              <Label>{fl.label}</Label>
              <Input value={f[fl.k] ?? ""} onChange={(e) => setF({ ...f, [fl.k]: e.target.value })} className="mt-1" />
            </div>
          ))}
        </div>
        {unlinked ? (
          <div className="mt-4 space-y-2 rounded-lg border border-sky-200 bg-sky-50 p-3 text-sm">
            <p className="text-sky-800">По новому номеру найдено непривязанных сообщений: <b>{unlinked.count}</b>. Привязать их к этому заказу?</p>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => { setUnlinked(null); setOpen(false); }}>Не сейчас</Button>
              <Button size="sm" disabled={busy} onClick={attach}>{busy ? "Привязка…" : "Привязать"}</Button>
            </div>
          </div>
        ) : (
          <div className="mt-5 flex justify-end gap-2">
            <DialogClose asChild>
              <Button variant="ghost" size="sm">Отмена</Button>
            </DialogClose>
            <Button size="sm" disabled={pending || busy} onClick={submit}>
              {pending || busy ? "Сохранение…" : "Сохранить"}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
