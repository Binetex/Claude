"use client";
import { useState, useTransition } from "react";
import { Megaphone } from "lucide-react";
import { toast } from "sonner";
import { Card, CardBody } from "@/components/ui/Card";
import { Button } from "@/components/ui/button";
import { ownerSetAiGlobalNote } from "./actions";

/**
 * Общее правило ассистента — одно на ВСЕ магазины.
 *
 * Живёт на странице списка магазинов, а не внутри одного: «сегодня выходной» касается всех, и
 * место такому правилу над списком, а не в карточке какого-то одного магазина.
 *
 * Срок обязателен по смыслу, хоть и не по форме: забытое «сегодня выходной» неделю отвечает
 * клиентам неправдой. Поэтому пустой срок подписан прямо, а не спрятан, и при сохранении без
 * срока показывается предупреждение.
 */
export function AiGlobalNotePanel({
  initial,
  today,
}: {
  initial: { text: string | null; activeUntil: string | null; updatedAt: string | null; active: boolean };
  /** Сегодняшний день по календарю магазинов — подставляется в поле срока по умолчанию. */
  today: string;
}) {
  const [text, setText] = useState(initial.text ?? "");
  const [until, setUntil] = useState(initial.activeUntil ?? "");
  const [pending, start] = useTransition();

  const dirty = text.trim() !== (initial.text ?? "").trim() || until !== (initial.activeUntil ?? "");

  function save(nextText: string, nextUntil: string) {
    start(async () => {
      const r = await ownerSetAiGlobalNote({ text: nextText, activeUntil: nextUntil || null });
      if (r?.error) toast.error(r.error);
      else toast.success(r?.message ?? "Сохранено");
    });
  }

  return (
    <Card>
      <CardBody className="space-y-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <Megaphone className="size-4 text-slate-400" />
          <h2 className="text-sm font-semibold text-slate-800">Общее правило для ассистента</h2>
          {initial.active ? (
            <span className="rounded border border-amber-200 bg-amber-50 px-1.5 py-px text-[11px] text-amber-800">
              действует{initial.activeUntil ? ` до ${initial.activeUntil}` : " бессрочно"}
            </span>
          ) : (
            <span className="rounded border border-slate-200 bg-slate-50 px-1.5 py-px text-[11px] text-slate-500">не задано</span>
          )}
        </div>
        <p className="text-xs text-slate-500">
          Действует сразу на все магазины и сильнее их баз знаний: «сегодня выходной», «заказы принимаем
          со вторника». Пока правило действует, готовые ответы на частые вопросы не используются — отвечает
          модель. Пишите по-русски, клиенту она переведёт смысл сама.
        </p>

        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={3}
          maxLength={1000}
          placeholder="Сегодня магазин не работает, доставок нет. Заказы принимаем со вторника."
          className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
        />

        <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
          <label htmlFor="ai-note-until">Действует до (включительно)</label>
          <input
            id="ai-note-until"
            type="date"
            value={until}
            min={today}
            onChange={(e) => setUntil(e.target.value)}
            className="rounded-md border border-slate-300 px-2 py-1 text-sm"
          />
          <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => setUntil(today)}>
            только сегодня
          </Button>
          {!until && text.trim() && <span className="text-amber-700">без срока правило будет действовать, пока его не снять</span>}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" disabled={pending || !dirty} onClick={() => save(text, until)}>
            {pending ? "Сохранение…" : "Сохранить"}
          </Button>
          {initial.text && (
            <Button
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={() => {
                setText("");
                setUntil("");
                save("", "");
              }}
            >
              Снять правило
            </Button>
          )}
          {initial.updatedAt && (
            <span className="text-[11px] text-slate-400">изменено {new Date(initial.updatedAt).toLocaleString("ru-RU")}</span>
          )}
        </div>
      </CardBody>
    </Card>
  );
}
