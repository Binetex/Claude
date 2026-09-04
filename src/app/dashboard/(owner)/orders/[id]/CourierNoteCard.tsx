"use client";
import { useState } from "react";
import { Truck, Pencil } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { COURIER_NOTE_MAX } from "@/lib/courierNote";
import { useBlockSave, ConflictNotice } from "./orderEditShared";

/**
 * Инструкция КУРЬЕРУ — единственное поле заказа, которое уезжает в Burq.
 *
 * Заводится редко и вручную: обычно флорист перед вызовом курьера дописывает то, чего нет в
 * адресе («ворота со стороны Sunset», «код 3262»). К стандартному тексту магазина
 * (Site.burqDefaultDropoffInstructions, там просьба сфотографировать букет) она ДОБАВЛЯЕТСЯ,
 * а не заменяет его.
 *
 * Отдельно от заметки заказчика намеренно: заметка — внутренняя запись команды («Просит
 * пораньше», «Тест»), и курьеру она попадать не должна. Раньше уезжала именно она.
 *
 * Живёт в блоке «Доставка» рядом с панелью Burq: заполняют её там же, где вызывают курьера.
 */
export function CourierNoteCard({
  orderId,
  updatedAt,
  courierNote,
  deliveryAlreadyCreated,
}: {
  orderId: string;
  updatedAt: string;
  courierNote: string;
  /** У созданного черновика Burq инструкцию уже не изменить — предупреждаем честно. */
  deliveryAlreadyCreated: boolean;
}) {
  const [note, setNote] = useState(courierNote);
  const [draft, setDraft] = useState(courierNote);
  const [editing, setEditing] = useState(false);
  const [seenProp, setSeenProp] = useState(courierNote);
  if (courierNote !== seenProp) {
    setSeenProp(courierNote);
    if (!editing) {
      setNote(courierNote);
      setDraft(courierNote);
    }
  }

  const { pending, conflict, save, acceptCurrentVersion } = useBlockSave(orderId, "courierNote", updatedAt, {
    hasUnsavedChanges: editing && draft !== note,
  });

  const tooLong = draft.trim().length > COURIER_NOTE_MAX;

  function submit() {
    save(
      { courierNote: draft },
      {
        successMessage: draft.trim() === "" ? "Инструкция курьеру убрана" : "Инструкция курьеру сохранена",
        onOk: () => {
          setNote(draft);
          setEditing(false);
        },
      }
    );
  }

  const warning = deliveryAlreadyCreated && (
    <p className="text-xs text-slate-500">
      Курьер уже вызван — он видит инструкцию, которая была на момент вызова. Новый текст
      уйдёт только со следующей доставкой; чтобы передать сейчас, свяжитесь с курьером.
    </p>
  );

  if (editing) {
    return (
      <div className="space-y-2 rounded-md border border-sky-200 bg-sky-50/50 p-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-semibold text-sky-900">Инструкция курьеру</span>
          <span className={`text-[11px] tabular-nums ${tooLong ? "font-medium text-red-600" : "text-slate-400"}`}>
            {draft.trim().length}/{COURIER_NOTE_MAX}
          </span>
        </div>
        <Textarea
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={2}
          placeholder="Например: ворота со стороны Sunset, код 3262"
        />
        <p className="text-xs text-slate-500">
          Уйдёт курьеру вместе со стандартным текстом магазина. Пусто — курьер получит только
          стандартный текст.
        </p>
        {warning}
        {conflict && (
          <ConflictNotice
            current={conflict.current}
            labels={[{ k: "courierNote", label: "Инструкция курьеру" }]}
            onRefresh={() =>
              acceptCurrentVersion((current) => {
                if ("courierNote" in current) {
                  setNote(current.courierNote);
                  setDraft(current.courierNote);
                }
              })
            }
          />
        )}
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => { setDraft(note); setEditing(false); }}>
            Отмена
          </Button>
          <Button size="sm" disabled={pending || draft === note || tooLong} onClick={submit}>
            {pending ? "Сохранение…" : "Сохранить"}
          </Button>
        </div>
      </div>
    );
  }

  if (note.trim() === "") {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-500 transition-colors hover:text-slate-800"
      >
        <Truck className="size-3.5" />
        Добавить инструкцию курьеру
      </button>
    );
  }

  return (
    <div className="rounded-md border border-sky-200 bg-sky-50/50 p-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-xs font-semibold text-sky-900">Инструкция курьеру</div>
          <div className="mt-0.5 max-h-32 overflow-y-auto break-words whitespace-pre-wrap text-slate-800">{note}</div>
        </div>
        <Button size="sm" variant="outline" className="shrink-0" onClick={() => setEditing(true)}>
          <Pencil className="size-3.5" />
          Изменить
        </Button>
      </div>
      {warning && <div className="mt-1">{warning}</div>}
    </div>
  );
}
