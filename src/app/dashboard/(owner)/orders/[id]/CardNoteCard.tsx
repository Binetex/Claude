"use client";
import { useState } from "react";
import { CopyButton } from "@/components/CopyButton";
import { Card, CardHeader, CardTitle, CardBody } from "@/components/ui/Card";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { useBlockSave, ConflictNotice } from "./orderEditShared";

/** Открытка + заметка клиента — важный блок, вынесен наверх. Меняется только вручную (OCC). */
export function CardNoteCard({
  orderId,
  updatedAt,
  cardMessage,
  customerNote,
}: {
  orderId: string;
  updatedAt: string;
  cardMessage: string;
  customerNote: string;
}) {
  const [card, setCard] = useState(cardMessage);
  const [note, setNote] = useState(customerNote);
  const [showNote, setShowNote] = useState(customerNote.trim() !== "");
  const { pending, conflict, save, acceptCurrentVersion } = useBlockSave(orderId, "cardNote", updatedAt);
  const dirty = card !== cardMessage || note !== customerNote;

  function submit() {
    save({ cardMessage: card, customerNote: note }, { successMessage: "Открытка и заметка сохранены" });
  }

  function refreshFromDb(current: Record<string, string>) {
    if ("cardMessage" in current) setCard(current.cardMessage);
    if ("customerNote" in current) {
      setNote(current.customerNote);
      if (current.customerNote.trim() !== "") setShowNote(true);
    }
  }

  return (
    <Card>
      <CardHeader className="flex items-center justify-between">
        <CardTitle>Открытка и заметка клиента</CardTitle>
        <Button size="sm" disabled={pending || !dirty} onClick={submit}>
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
        {conflict && (
          <ConflictNotice
            current={conflict.current}
            labels={[{ k: "cardMessage", label: "Открытка" }, { k: "customerNote", label: "Заметка" }]}
            onRefresh={() => acceptCurrentVersion(refreshFromDb)}
          />
        )}
      </CardBody>
    </Card>
  );
}
