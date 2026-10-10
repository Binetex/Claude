"use client";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { ownerSetFloristTelegram } from "./floristActions";

/**
 * Ник флориста в Telegram. Им её отмечают в срочных уведомлениях («позвоните курьеру»): в группе
 * Telegram пиликает отмеченному лично, даже если чат заглушён. Сохраняется по Enter или уходу с поля.
 */
export function TelegramHandleEditor({ floristId, handle }: { floristId: string; handle: string | null }) {
  const [pending, start] = useTransition();
  const [value, setValue] = useState(handle ?? "");
  const [saved, setSaved] = useState(handle ?? "");

  function save() {
    if (value.trim() === saved) return;
    start(async () => {
      const res = await ownerSetFloristTelegram(floristId, value);
      if (res.error) {
        toast.error(res.error);
        return;
      }
      setValue(res.value ?? "");
      setSaved(res.value ?? "");
      toast.success(res.value ? `Будем отмечать ${res.value}` : "Ник убран");
    });
  }

  return (
    <label className="mt-2 flex flex-wrap items-center gap-2 text-sm text-slate-600">
      <span>Ник в Telegram</span>
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), save())}
        disabled={pending}
        placeholder="@arina"
        className="w-40 rounded-lg border border-slate-200 bg-white px-2 py-1 text-sm text-slate-800 disabled:opacity-50"
      />
      <span className="text-xs text-slate-400">отмечаем в срочных уведомлениях о доставке</span>
    </label>
  );
}
