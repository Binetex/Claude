"use client";
import { useState } from "react";

export function CopyButton({ text, label = "Копировать" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className="rounded-md border border-slate-200 bg-white px-2 py-1 text-xs text-slate-600 hover:bg-slate-50"
    >
      {copied ? "Скопировано ✓" : label}
    </button>
  );
}
