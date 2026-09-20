"use client";
/**
 * Кнопки-заготовки над полем отправки: нажал — текст встал в поле, дальше правишь и отправляешь.
 *
 * Именно вставка, а не отправка: половину заготовок владелец дописывает под случай («закончилась
 * ваза» — какая именно, «не дозвонились» — что делать дальше). Кнопка, отправляющая сразу, эту
 * правку отнимает, а ошибку показать клиенту уже не отменить.
 *
 * Заготовок больше десятка, поэтому список свёрнут: над полем ввода всегда видна одна строка,
 * а не стена кнопок. На телефоне это разница между «вижу поле» и «листаю до него».
 */
import { useState } from "react";
import { FileText } from "lucide-react";

export type TemplateChoice = { id: string; title: string; text: string; missing: string[] };

export function MessageTemplatePicker({ templates, onPick }: { templates: TemplateChoice[]; onPick: (text: string) => void }) {
  const [open, setOpen] = useState(false);
  if (templates.length === 0) return null;

  return (
    <div className="text-xs">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 rounded border border-slate-200 bg-white px-2 py-1 text-slate-600 hover:bg-slate-50"
      >
        <FileText aria-hidden className="size-3.5 text-slate-400" />
        Заготовки ({templates.length})
        <span className="text-slate-400">{open ? "▲" : "▼"}</span>
      </button>

      {open && (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {templates.map((t) => (
            <button
              key={t.id}
              type="button"
              title={t.text}
              onClick={() => {
                onPick(t.text);
                setOpen(false);
              }}
              className="max-w-full rounded-full border border-slate-300 bg-slate-50 px-2.5 py-1 text-left text-slate-700 hover:border-slate-400 hover:bg-white"
            >
              {t.title}
              {/* Заготовка ссылалась на то, чего у заказа нет: строка с пустой переменной из
                  текста выпадет. Честнее сказать об этом до вставки, чем дать урезанный текст. */}
              {t.missing.length > 0 && <span className="ml-1 text-amber-600" title={`Нет данных: ${t.missing.join(", ")}`}>·</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
