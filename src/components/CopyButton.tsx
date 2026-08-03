"use client";
import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { Tooltip } from "@/components/ui/tooltip";

/**
 * Копирование текста в буфер.
 *
 * `iconOnly` — компактный вариант для плотных блоков (карточка заказа у флориста): подпись
 * уходит в tooltip и aria-label, поэтому смысл кнопки остаётся доступен и с клавиатуры, и
 * скринридером, а строка заголовка не растягивается словом «Копировать».
 */
export function CopyButton({
  text,
  label = "Копировать",
  iconOnly = false,
}: {
  text: string;
  label?: string;
  iconOnly?: boolean;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  if (iconOnly) {
    return (
      <Tooltip content={copied ? "Скопировано" : label}>
        <button
          type="button"
          onClick={copy}
          aria-label={label}
          className="rounded-md border border-slate-200 bg-white p-1.5 text-slate-500 hover:bg-slate-50 hover:text-slate-800"
        >
          {copied ? <Check className="size-3.5 text-emerald-600" /> : <Copy className="size-3.5" />}
        </button>
      </Tooltip>
    );
  }

  return (
    <button
      onClick={copy}
      className="rounded-md border border-slate-200 bg-white px-2 py-1 text-xs text-slate-600 hover:bg-slate-50"
    >
      {copied ? "Скопировано ✓" : label}
    </button>
  );
}
