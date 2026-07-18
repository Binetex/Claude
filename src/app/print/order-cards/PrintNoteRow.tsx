"use client";
import { useState, useTransition } from "react";

type SaveResult = { ok?: boolean; error?: string; message?: string };

export type PrintNoteRowOrder = {
  orderId: string;
  orderNumber: string;
  recipientName: string;
  deliveryDate: string;
  cardMessage: string;
  hasCardMessage: boolean;
  siteName: string;
};

/**
 * Строка заказа во вкладке «Открытки для печати»: редактор ТЕКСТА ОТКРЫТКИ + печать.
 * Если есть несохранённые изменения — печать не открывается молча, показывается предупреждение
 * «Сначала сохраните текст открытки».
 */
export function PrintNoteRow({ order, save }: { order: PrintNoteRowOrder; save: (orderId: string, text: string) => Promise<SaveResult> }) {
  const [text, setText] = useState(order.cardMessage ?? "");
  const [saved, setSaved] = useState(order.cardMessage ?? "");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const dirty = text !== saved;

  const doSave = () =>
    start(async () => {
      const r = await save(order.orderId, text);
      if (r.ok) {
        setSaved(text);
        setMsg({ ok: true, text: r.message ?? "Сохранено" });
      } else {
        setMsg({ ok: false, text: r.error ?? "Ошибка" });
      }
    });

  const doPrint = () => {
    if (dirty) {
      setMsg({ ok: false, text: "Сначала сохраните текст открытки" });
      return;
    }
    window.open(`/print/order-cards?ids=${encodeURIComponent(order.orderId)}`, "_blank", "noopener");
  };

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3 space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm">
          <span className="font-semibold text-slate-800">{order.orderNumber}</span>{" "}
          <span className="text-slate-600">· {order.recipientName}</span>{" "}
          <span className="text-slate-400">· {order.deliveryDate} · {order.siteName}</span>
        </div>
        {!order.hasCardMessage && !text.trim() && <span className="text-xs text-amber-700">Текст открытки отсутствует</span>}
      </div>
      <textarea
        value={text}
        onChange={(e) => { setText(e.target.value); setMsg(null); }}
        rows={3}
        maxLength={10000}
        placeholder="Текст открытки…"
        className="w-full rounded-md border border-slate-300 p-2 text-sm"
        aria-label="Текст открытки"
      />
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={doSave} disabled={pending || !dirty} className="rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-700 disabled:opacity-40">
          {pending ? "…" : "Сохранить текст"}
        </button>
        <button type="button" onClick={doPrint} className="rounded-md bg-slate-800 px-3 py-1.5 text-sm text-white">
          Печать открытки
        </button>
        {dirty && <span className="text-xs text-amber-600">есть несохранённые изменения</span>}
        {msg && <span className={msg.ok ? "text-xs text-emerald-700" : "text-xs text-red-600"}>{msg.text}</span>}
      </div>
    </div>
  );
}
