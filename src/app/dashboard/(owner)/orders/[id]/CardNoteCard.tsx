"use client";
import { useState } from "react";
import { ChevronRight, StickyNote } from "lucide-react";
import { CopyButton } from "@/components/CopyButton";
import { PrintCardButton } from "@/components/PrintCardButton";
import { Card, CardHeader, CardTitle, CardBody } from "@/components/ui/Card";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { useBlockSave, ConflictNotice } from "./orderEditShared";

/** Открытка + заметка заказчика — важный блок, вынесен наверх. Меняется только вручную (OCC). */
export function CardNoteCard({
  orderId,
  updatedAt,
  cardMessage,
  customerNote,
  showPrint = false,
  collapsible = false,
}: {
  orderId: string;
  updatedAt: string;
  cardMessage: string;
  customerNote: string;
  /** Кнопка печати открытки. Включается точечно (кабинет флориста); у владельца и
      колл-центра блок остаётся прежним. */
  showPrint?: boolean;
  /**
   * Сворачивать блок. Начальное состояние определяется СОДЕРЖИМЫМ: с текстом открытки
   * раскрыт, пустой — свёрнут. Хранить выбор между заходами (localStorage) нельзя без
   * применения в эффекте, а это прыжок вёрстки после гидрации.
   *
   * Заодно это признак плотной компоновки: копирование и печать становятся иконками.
   * Отдельного флага для этого нет — сворачиваемый вариант и есть компактный.
   */
  collapsible?: boolean;
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

  const saveButton = (
    <Button size="sm" disabled={pending || !dirty} onClick={submit}>
      {pending ? "Сохранение…" : "Сохранить"}
    </Button>
  );

  const body = (
    <>
      <div>
        <div className="mb-1 flex flex-wrap items-center justify-between gap-1.5">
          <span className="text-xs font-medium text-slate-500">Текст открытки</span>
          <span className="flex flex-wrap items-center gap-1.5">
            <CopyButton text={card} iconOnly={collapsible} />
            {showPrint && (
              <PrintCardButton orderId={orderId} hasCardMessage={card.trim() !== ""} dirty={dirty} iconOnly={collapsible} />
            )}
          </span>
        </div>
        <Textarea value={card} onChange={(e) => setCard(e.target.value)} rows={3} placeholder="Текст открытки…" />
      </div>
      {showNote ? (
        <div>
          <div className="mb-1 flex items-center justify-between">
            <span className="text-xs font-medium text-slate-500">Заметка заказчика</span>
            <CopyButton text={note} iconOnly={collapsible} />
          </div>
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="Внутренняя заметка…" />
        </div>
      ) : (
        <button onClick={() => setShowNote(true)} className="text-xs font-medium text-sky-600 hover:text-sky-800">
          + Добавить заметку заказчика
        </button>
      )}
      {conflict && (
        <ConflictNotice
          current={conflict.current}
          labels={[{ k: "cardMessage", label: "Открытка" }, { k: "customerNote", label: "Заметка" }]}
          onRefresh={() => acceptCurrentVersion(refreshFromDb)}
        />
      )}
    </>
  );

  if (!collapsible) {
    return (
      <Card>
        <CardHeader className="flex items-center justify-between">
          <CardTitle>Открытка и заметка заказчика</CardTitle>
          {saveButton}
        </CardHeader>
        <CardBody className="space-y-3">{body}</CardBody>
      </Card>
    );
  }

  // Кнопка сохранения — ВНУТРИ раскрытой части, а не в summary: клик по summary
  // переключает details, и «Сохранить» рядом с заголовком схлопывал бы блок.
  return (
    <Card>
      <details open={cardMessage.trim() !== ""} className="group">
        <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-t-xl px-4 py-2.5 transition-colors hover:bg-slate-50">
          <ChevronRight
            aria-hidden
            className="size-4 shrink-0 text-slate-400 transition-transform duration-200 group-open:rotate-90"
          />
          <CardTitle icon={StickyNote}>Открытка и заметки</CardTitle>
        </summary>
        <CardBody className="space-y-3 pt-0">
          {body}
          <div className="flex justify-end">{saveButton}</div>
        </CardBody>
      </details>
    </Card>
  );
}
