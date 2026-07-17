"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronRight, ChevronDown, Copy, Check, RefreshCw } from "lucide-react";
import { Tooltip } from "@/components/ui/tooltip";
import type { PurchaseItem } from "@/modules/purchase/list";

const NOT_SET = "Состав варианта не указан";

function compositionLines(c: string | null): string[] {
  if (!c || !c.trim()) return [NOT_SET];
  return c.split("\n").map((s) => s.trim()).filter(Boolean);
}

const iconBtn = "rounded p-1 text-slate-500 hover:bg-white hover:text-slate-800";

export function PurchaseList({ items, text }: { items: PurchaseItem[]; text: string }) {
  const [mode, setMode] = useState<"compact" | "detailed">("compact");
  const [copied, setCopied] = useState(false);
  const router = useRouter();

  function copy() {
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50/50 p-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <Tooltip content={mode === "compact" ? "Развернуть" : "Свернуть"}>
            <button onClick={() => setMode(mode === "compact" ? "detailed" : "compact")} className={iconBtn}>
              {mode === "compact" ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
            </button>
          </Tooltip>
          <span className="text-sm font-semibold text-slate-800">
            Сегодня нужно купить <span className="font-normal text-slate-500">({items.length})</span>
          </span>
        </div>
        <div className="flex items-center gap-0.5">
          <Tooltip content="Копировать список">
            <button onClick={copy} className={iconBtn}>
              {copied ? <Check size={16} className="text-emerald-600" /> : <Copy size={16} />}
            </button>
          </Tooltip>
          <Tooltip content="Обновить">
            <button onClick={() => router.refresh()} className={iconBtn}>
              <RefreshCw size={16} />
            </button>
          </Tooltip>
        </div>
      </div>

      {items.length === 0 ? (
        <div className="mt-1.5 text-xs text-slate-500">На сегодня закупок нет.</div>
      ) : mode === "compact" ? (
        <ul className="mt-1.5 space-y-0.5 text-xs text-slate-700">
          {items.map((it, i) => (
            <li key={i}>
              {it.quantity} × [{compositionLines(it.composition).join("; ")}]
            </li>
          ))}
        </ul>
      ) : (
        <ul className="mt-1.5 space-y-2 text-xs">
          {items.map((it, i) => (
            <li key={i}>
              <div className="font-medium text-slate-800">
                {it.orderNumber} — {it.productName}
                {it.variantName ? <span className="font-bold text-red-600"> — {it.variantName}</span> : null} × {it.quantity}
              </div>
              <div className="whitespace-pre-line text-slate-600">
                {it.composition && it.composition.trim() ? it.composition : <span className="text-slate-400 italic">{NOT_SET}</span>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
