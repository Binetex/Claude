"use client";
import { useState } from "react";
import { Pencil } from "lucide-react";
import { Dialog, DialogTrigger, DialogContent, DialogHeader, DialogTitle, DialogClose } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useBlockSave, ConflictNotice } from "./orderEditShared";

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
  const block = kind === "recipient" ? "contacts" : "sender";
  const { pending, conflict, save, acceptCurrentVersion } = useBlockSave(orderId, block, updatedAt);

  const allFields = kind === "recipient" ? RECIPIENT_FIELDS : SENDER_FIELDS;
  const fields = allFields.filter((fl) => fl.k in initial);
  const title = kind === "recipient" ? "Получатель" : "Отправитель";

  function submit() {
    // Отправляем только видимые поля блока.
    const data: Record<string, string> = {};
    for (const fl of fields) data[fl.k] = f[fl.k] ?? "";
    save(data, { successMessage: `${title} обновлён`, onOk: () => setOpen(false) });
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
        <div className="mt-5 flex justify-end gap-2">
          <DialogClose asChild>
            <Button variant="ghost" size="sm">Отмена</Button>
          </DialogClose>
          <Button size="sm" disabled={pending} onClick={submit}>
            {pending ? "Сохранение…" : "Сохранить"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
