import type { LucideIcon } from "lucide-react";
import { Contact, Mail, MapPin, Phone, UserRound } from "lucide-react";
import { Card, CardHeader, CardTitle, CardBody } from "@/components/ui/Card";

/**
 * Карточки «Получатель» и «Заказчик». Один блок на владельца, колл-центр и флориста.
 *
 * До объединения вёрстка была написана трижды и разошлась в мелочах: у флориста иконки-якоря
 * и адрес, у владельца адрес отправителя и e-mail без иконок, у колл-центра третий вариант.
 * Роль задаёт ТОЛЬКО НАБОР ПОЛЕЙ: не переданное поле просто не рисуется, отдельной ветки
 * «для такой-то роли» здесь нет.
 *
 * Порядок карточек — как у флориста: сначала получатель (кому везём), потом заказчик.
 */
export type ContactView = {
  name: string;
  phone: string;
  /** Не передан — строки не будет (флористу e-mail не отдаётся). */
  email?: string | null;
  /** Адрес несколькими строками; пустой массив — блока адреса не будет. */
  addressLines?: string[];
  /** Иконка-карандаш правки (ContactEditDialog). Нет прав — не передавайте. */
  edit?: React.ReactNode;
};

function Line({ icon: Icon, children, className }: { icon: LucideIcon; children: React.ReactNode; className?: string }) {
  return (
    <div className={`flex items-start gap-2 text-slate-600 ${className ?? ""}`}>
      <Icon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-slate-400" />
      <span className="min-w-0 flex-1">{children}</span>
    </div>
  );
}

function ContactCard({
  title,
  icon,
  contact,
}: {
  title: string;
  icon: LucideIcon;
  contact: ContactView;
}) {
  const address = (contact.addressLines ?? []).filter((l) => l.trim().length > 0);
  return (
    /* min-w-0: длинный e-mail — сплошной токен без пробелов, и без этого он задавал бы
       минимальную ширину колонки, раздувая обе карточки. */
    <Card className="min-w-0">
      <CardHeader className="flex items-center justify-between py-2.5">
        <CardTitle icon={icon}>{title}</CardTitle>
        {contact.edit}
      </CardHeader>
      <CardBody className="space-y-1.5 text-sm">
        <div className="font-medium break-words text-slate-800">{contact.name}</div>
        <Line icon={Phone}>
          <span className="tabular-nums">{contact.phone || "—"}</span>
        </Line>
        {contact.email !== undefined && (
          /* break-all: у адреса почты нет пробелов, «переносить по словам» для него
             равносильно «не переносить». */
          <Line icon={Mail}>
            <span className="break-all">{contact.email || "—"}</span>
          </Line>
        )}
        {contact.addressLines !== undefined && (
          <Line icon={MapPin}>
            {address.length > 0 ? (
              <span className="break-words">
                {address.map((l, i) => (
                  <span key={i} className="block">{l}</span>
                ))}
              </span>
            ) : (
              <span className="text-slate-400">Адрес не указан</span>
            )}
          </Line>
        )}
      </CardBody>
    </Card>
  );
}

export function OrderContactCards({
  recipient,
  customer,
}: {
  recipient: ContactView;
  customer: ContactView;
}) {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <ContactCard title="Получатель" icon={UserRound} contact={recipient} />
      <ContactCard title="Заказчик" icon={Contact} contact={customer} />
    </div>
  );
}
