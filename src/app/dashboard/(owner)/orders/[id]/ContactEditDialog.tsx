"use client";
import { useState, useTransition } from "react";
import { Pencil } from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogTrigger, DialogContent, DialogHeader, DialogTitle, DialogClose } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useBlockSave, ConflictNotice } from "./orderEditShared";
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
 * Единый путь сохранения (OCC): владелец/колл-центр/флорист. Показываются только те поля,
 * что переданы в `initial` (например, флористу отправитель отдаётся без email).
 */
export function ContactEditDialog({
  kind,
  orderId,
  updatedAt,
  initial,
}: {
  kind: "recipient" | "sender";
  orderId: string;
  updatedAt: string;
  initial: Record<string, string>;
}) {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState<Record<string, string>>(initial);
  const [unlinked, setUnlinked] = useState<{ count: number } | null>(null);
  const [busy, startBusy] = useTransition();
  const block = kind === "recipient" ? "contacts" : "sender";
  const side = kind === "recipient" ? "RECIPIENT" : "CUSTOMER";
  const phoneKey = kind === "recipient" ? "recipientPhone" : "senderPhone";
  const { pending, conflict, save, acceptCurrentVersion } = useBlockSave(orderId, block, updatedAt);

  const allFields = kind === "recipient" ? RECIPIENT_FIELDS : SENDER_FIELDS;
  const fields = allFields.filter((fl) => fl.k in initial);
  const title = kind === "recipient" ? "Получатель" : "Отправитель";

  function submit() {
    // Отправляем только видимые поля блока.
    const data: Record<string, string> = {};
    for (const fl of fields) data[fl.k] = f[fl.k] ?? "";
    const phoneChanged = (f[phoneKey] ?? "") !== (initial[phoneKey] ?? "");
    // onOk НЕ вызывается при OCC-конфликте (useBlockSave) → при конфликте ничего не ищем.
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

  function refreshFromDb(current: Record<string, string>) {
    setF((prev) => {
      const next = { ...prev };
      for (const fl of fields) if (fl.k in current) next[fl.k] = current[fl.k];
      return next;
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="iconSm" title="Редактировать">
          <Pencil />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Редактировать: {title.toLowerCase()}</DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          {fields.map((fl) => (
            <div key={fl.k} className={fl.wide ? "col-span-2" : ""}>
              <Label>{fl.label}</Label>
              <Input value={f[fl.k] ?? ""} onChange={(e) => setF({ ...f, [fl.k]: e.target.value })} className="mt-1" />
            </div>
          ))}
        </div>
        {conflict && (
          <div className="mt-4">
            <ConflictNotice current={conflict.current} labels={fields} onRefresh={() => acceptCurrentVersion(refreshFromDb)} />
          </div>
        )}
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
