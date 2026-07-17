"use client";
import { useTransition } from "react";
import { toast } from "sonner";
import { ownerSetFloristFinanceVisibility } from "@/app/dashboard/(owner)/actions";
import { cn } from "@/lib/cn";
import type { FloristFinanceVisibility } from "@/generated/prisma/enums";

export function FinanceVisibilityToggle({
  floristId,
  current,
}: {
  floristId: string;
  current: FloristFinanceVisibility;
}) {
  const [pending, start] = useTransition();

  function set(v: FloristFinanceVisibility) {
    if (v === current || pending) return;
    start(async () => {
      await ownerSetFloristFinanceVisibility(floristId, v);
      toast.success("Видимость финансов обновлена");
    });
  }

  const opt = (v: FloristFinanceVisibility, label: string) => (
    <button
      onClick={() => set(v)}
      disabled={pending}
      className={cn(
        "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
        current === v ? "bg-white text-slate-900 shadow-xs" : "text-slate-500 hover:text-slate-800"
      )}
    >
      {label}
    </button>
  );

  return (
    <div className="mt-2 inline-flex items-center gap-0.5 rounded-lg bg-slate-100 p-0.5">
      {opt("MAKER_ONLY", "Только своя цена")}
      {opt("FULL", "Полная цена")}
    </div>
  );
}
