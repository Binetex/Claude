"use client";
import { useState, useTransition } from "react";
import { Pencil } from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogTrigger, DialogContent, DialogHeader, DialogTitle, DialogClose } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ownerUpdateContacts, ownerUpdateSender } from "@/app/dashboard/(owner)/actions";

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

/** Иконка-редактирование на карточке «Отправитель»/«Получатель» → модалка с полями. */
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
  const [pending, start] = useTransition();
  const [f, setF] = useState<Record<string, string>>(initial);
  const fields = kind === "recipient" ? RECIPIENT_FIELDS : SENDER_FIELDS;
  const title = kind === "recipient" ? "Получатель" : "Отправитель";

  function save() {
    start(async () => {
      if (kind === "recipient") await ownerUpdateContacts(orderId, f);
      else await ownerUpdateSender(orderId, f);
      toast.success(`${title} обновлён`);
      setOpen(false);
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
        <div className="mt-5 flex justify-end gap-2">
          <DialogClose asChild>
            <Button variant="ghost" size="sm">Отмена</Button>
          </DialogClose>
          <Button size="sm" disabled={pending} onClick={save}>
            {pending ? "Сохранение…" : "Сохранить"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
