"use client";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { ownerUpdateCardAndNote } from "@/app/dashboard/(owner)/actions";
import { CopyButton } from "@/components/CopyButton";
import { Card, CardHeader, CardTitle, CardBody } from "@/components/ui/Card";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";

/** Открытка + заметка клиента — важный блок, вынесен наверх. Меняется только вручную. */
export function CardNoteCard({
  orderId,
  cardMessage,
  customerNote,
}: {
  orderId: string;
  cardMessage: string;
  customerNote: string;
}) {
  const [card, setCard] = useState(cardMessage);
  const [note, setNote] = useState(customerNote);
  const [showNote, setShowNote] = useState(customerNote.trim() !== "");
  const [pending, start] = useTransition();
  const dirty = card !== cardMessage || note !== customerNote;

  function save() {
    start(async () => {
      await ownerUpdateCardAndNote(orderId, { cardMessage: card, customerNote: note });
      toast.success("Открытка и заметка сохранены");
    });
  }

  return (
    <Card>
      <CardHeader className="flex items-center justify-between">
        <CardTitle>Открытка и заметка клиента</CardTitle>
        <Button size="sm" disabled={pending || !dirty} onClick={save}>
          {pending ? "Сохранение…" : "Сохранить"}
        </Button>
      </CardHeader>
      <CardBody className="space-y-3">
        <div>
          <div className="mb-1 flex items-center justify-between">
            <span className="text-xs font-medium text-slate-500">Текст открытки</span>
            <CopyButton text={card} />
          </div>
          <Textarea value={card} onChange={(e) => setCard(e.target.value)} rows={3} placeholder="Текст открытки…" />
        </div>
        {showNote ? (
          <div>
            <div className="mb-1 flex items-center justify-between">
              <span className="text-xs font-medium text-slate-500">Заметка клиента</span>
              <CopyButton text={note} />
            </div>
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="Внутренняя заметка…" />
          </div>
        ) : (
          <button
            onClick={() => setShowNote(true)}
            className="text-xs font-medium text-sky-600 hover:text-sky-800"
          >
            + Добавить заметку клиента
          </button>
        )}
      </CardBody>
    </Card>
  );
}
