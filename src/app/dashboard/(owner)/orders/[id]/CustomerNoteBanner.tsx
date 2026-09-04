"use client";
import { useState } from "react";
import { StickyNote, Pencil } from "lucide-react";
import { CopyButton } from "@/components/CopyButton";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { useBlockSave, ConflictNotice } from "./orderEditShared";

/**
 * Заметка заказчика — ОТДЕЛЬНОЙ плашкой сразу под полосой доставки, у всех трёх ролей.
 *
 * Почему не внутри блока «Открытка»: там она лежала ниже половины страницы и в свёрнутом
 * виде, поэтому «позвонить за час до доставки» видел только тот, кто знал, куда смотреть.
 * Заметка касается ВЫПОЛНЕНИЯ заказа, значит читаться должна там же, где дата доставки, —
 * первым экраном и жёлтым, чтобы взгляд цеплялся.
 *
 * Единственное место заметки в карточке: из «Открытки» она убрана намеренно. Два поля,
 * правящих одно значение на одной странице, спорили бы друг с другом через OCC.
 *
 * Править может любой редактор заказа (владелец, колл-центр, флорист своего заказа) — права
 * целиком на стороне `saveOrderBlock`, компонент ролей не знает.
 */
export function CustomerNoteBanner({
  orderId,
  updatedAt,
  customerNote,
}: {
  orderId: string;
  updatedAt: string;
  customerNote: string;
}) {
  const [note, setNote] = useState(customerNote);
  const [draft, setDraft] = useState(customerNote);
  const [editing, setEditing] = useState(false);
  // Проп обновляется при каждой перерисовке страницы (revalidatePath после любого
  // сохранения). Подхватываем его, пока заметку не правят: иначе заметка, добавленная
  // ДРУГИМ сотрудником, не появилась бы на экране до перезагрузки карточки.
  const [seenProp, setSeenProp] = useState(customerNote);
  if (customerNote !== seenProp) {
    setSeenProp(customerNote);
    if (!editing) {
      setNote(customerNote);
      setDraft(customerNote);
    }
  }
  const { pending, conflict, save, acceptCurrentVersion } = useBlockSave(orderId, "cardNote", updatedAt, {
    hasUnsavedChanges: editing && draft !== note,
  });

  function submit() {
    // Шлём ТОЛЬКО заметку: блок cardNote пишет лишь присланные поля, поэтому текст
    // открытки, который правят в своём блоке, отсюда затереть невозможно.
    save(
      { customerNote: draft },
      {
        successMessage: draft.trim() === "" ? "Заметка удалена" : "Заметка сохранена",
        onOk: () => {
          setNote(draft);
          setEditing(false);
        },
      }
    );
  }

  function cancel() {
    setDraft(note);
    setEditing(false);
  }

  function startEdit() {
    setDraft(note);
    setEditing(true);
  }

  if (editing) {
    return (
      <div className="space-y-2 rounded-xl border border-amber-300 bg-white px-3.5 py-2.5 shadow-sm">
        <div className="flex items-center gap-2 text-[11px] font-medium tracking-wider text-amber-700 uppercase">
          <StickyNote className="size-4 shrink-0 text-amber-600" />
          Заметка заказчика
        </div>
        <Textarea
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={2}
          placeholder="Например: позвонить за час до доставки"
        />
        {conflict && (
          <ConflictNotice
            current={conflict.current}
            labels={[{ k: "customerNote", label: "Заметка" }]}
            onRefresh={() =>
              acceptCurrentVersion((current) => {
                if ("customerNote" in current) {
                  setNote(current.customerNote);
                  setDraft(current.customerNote);
                }
              })
            }
          />
        )}
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" disabled={pending} onClick={cancel}>
            Отмена
          </Button>
          <Button size="sm" disabled={pending || draft === note} onClick={submit}>
            {pending ? "Сохранение…" : "Сохранить"}
          </Button>
        </div>
      </div>
    );
  }

  // Пусто — не занимаем первый экран жёлтым: только тихая строка, чтобы заметку можно
  // было добавить оттуда же, где её потом будут читать.
  if (note.trim() === "") {
    return (
      <button
        type="button"
        onClick={startEdit}
        className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-500 transition-colors hover:text-slate-800"
      >
        <StickyNote className="size-3.5" />
        Добавить заметку заказчика
      </button>
    );
  }

  return (
    <div className="flex items-start gap-2.5 rounded-xl border border-amber-300 bg-amber-50 px-3.5 py-2.5 shadow-sm">
      <StickyNote className="mt-0.5 size-4 shrink-0 text-amber-600" />
      <div className="min-w-0 flex-1">
        <div className="text-[11px] font-medium tracking-wider text-amber-700 uppercase">Заметка заказчика</div>
        {/* whitespace-pre-wrap: заметку пишут строками («позвонить», «код домофона») —
            склеивать их в абзац значит терять смысл. break-words — против длинных ссылок. */}
        <p className="mt-0.5 max-h-40 overflow-y-auto text-sm break-words whitespace-pre-wrap text-amber-950">
          {note}
        </p>
      </div>
      <span className="flex shrink-0 items-center gap-1.5">
        {/* Копирование — не украшение: код домофона и инструкцию пересылают курьеру. */}
        <CopyButton text={note} iconOnly />
        <Button size="sm" variant="outline" onClick={startEdit}>
          <Pencil className="size-3.5" />
          Изменить
        </Button>
      </span>
    </div>
  );
}
