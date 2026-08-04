"use client";
/** Установка доли основного флориста и ручной пересчёт. */
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { applyPrimarySharePercent, recomputePrimaryShare } from "@/app/dashboard/(owner)/finance/setup/setupActions";

export function SharePercentForm({
  floristId,
  defaultDate,
  compact = false,
}: {
  floristId: string;
  defaultDate: Date | null;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(!compact);
  const [pending, start] = useTransition();
  const date = (defaultDate ?? new Date()).toISOString().slice(0, 10);

  if (compact && !open) {
    return (
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
        Изменить долю
      </Button>
    );
  }

  return (
    <form
      action={(fd) =>
        start(async () => {
          const res = await applyPrimarySharePercent(fd);
          if (res.error) {
            toast.error(res.error);
            return;
          }
          toast.success(res.message ?? "Сохранено");
          if (compact) setOpen(false);
        })
      }
      className="flex flex-wrap items-end gap-2"
    >
      <input type="hidden" name="floristId" value={floristId} />
      <div className="space-y-1">
        <Label className="text-xs">Доля, %</Label>
        <Input name="percent" inputMode="decimal" placeholder="66.60" defaultValue="66.60" className="h-8 w-24 text-sm" required />
      </div>
      <div className="space-y-1">
        <Label className="text-xs">Действует с</Label>
        <Input name="effectiveFrom" type="date" defaultValue={date} className="h-8 w-40 text-sm" />
      </div>
      <Button type="submit" size="sm" disabled={pending}>
        {pending ? "Сохраняю…" : "Сохранить"}
      </Button>
      {compact && (
        <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
          Отмена
        </Button>
      )}
    </form>
  );
}

export function RecomputeShareButton() {
  const [pending, start] = useTransition();
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={pending}
      onClick={() =>
        start(async () => {
          const res = await recomputePrimaryShare();
          if (res.error) toast.error(res.error);
          else toast.success(res.message ?? "Готово");
        })
      }
    >
      {pending ? "Считаю…" : "Пересчитать"}
    </Button>
  );
}
