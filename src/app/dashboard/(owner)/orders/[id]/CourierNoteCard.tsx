"use client";
import { useState } from "react";
import { Truck, Pencil, Sparkles } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { COURIER_NOTE_MAX } from "@/lib/courierNote";
import { useBlockSave } from "./orderEditShared";

/**
 * Инструкция КУРЬЕРУ — единственное поле заказа, которое уезжает в Burq.
 *
 * Пишется САМА (владелец 13.10.2026, `modules/courierNote`): ИИ берёт из инструкций покупателя
 * на сайте, его SMS и заметки команды только то, что нужно курьеру («код 3262», «оставить у
 * консьержа»), и черновик Burq, пока курьер не вызван, пересоздаётся с новым текстом. Человек
 * может поправить — после правки ИИ его текст не переписывает, только дописывает новое строкой
 * ниже; стёр человек — ИИ больше не пишет. К стандартному тексту магазина
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
  courierNote,
  byAi,
  courierCalled,
}: {
  orderId: string;
  courierNote: string;
  /** Текст собрал ИИ, человек его не правил. */
  byAi: boolean;
  /** Курьер уже вызван: в Burq инструкцию не изменить — предупреждаем честно. */
  courierCalled: boolean;
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

  const { pending, save } = useBlockSave(orderId, "courierNote");

  const tooLong = draft.trim().length > COURIER_NOTE_MAX;

  function submit() {
    save(
      // С какого текста начиналась правка: ИИ мог обновить инструкцию после открытия страницы, и
      // сервер не даст молча затереть его текст.
      { courierNote: draft, courierNoteBase: note },
      {
        successMessage: draft.trim() === "" ? "Инструкция курьеру убрана" : "Инструкция курьеру сохранена",
        onOk: () => {
          setNote(draft);
          setEditing(false);
        },
      }
    );
  }

  const warning = courierCalled && (
    <p className="text-xs text-slate-500">
      Курьер уже вызван — он видит инструкцию, которая была на момент вызова. Новый текст
      передайте ему сами.
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
          placeholder="Gate on Sunset side, code 3262. Leave at front door."
        />
        <p className="text-xs text-slate-500">
          Уйдёт курьеру как есть, по-английски, вместе со стандартным текстом магазина. После
          вашей правки ИИ этот текст не переписывает, только дописывает новое от клиента; пусто —
          ИИ больше не пишет.
        </p>
        {warning}
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
          <div className="flex items-center gap-1.5 text-xs font-semibold text-sky-900">
            Инструкция курьеру
            {byAi && (
              <span className="inline-flex items-center gap-0.5 font-normal text-sky-700" title="Собрал ИИ из слов клиента">
                <Sparkles className="size-3" aria-hidden />
                ИИ
              </span>
            )}
          </div>
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
