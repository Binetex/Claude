"use client";
import { useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { recomputeDayAction } from "./actions";

export function RecomputeDayButton({ day, floristId }: { day: string; floristId: string }) {
  const [pending, start] = useTransition();
  return (
    <form
      action={(fd) =>
        start(async () => {
          const res = await recomputeDayAction(fd);
          if (res.error) toast.error(res.error);
          else toast.success(res.message ?? "Пересчитано");
        })
      }
    >
      <input type="hidden" name="day" value={day} />
      <input type="hidden" name="floristId" value={floristId} />
      <Button type="submit" size="sm" variant="outline" disabled={pending}>
        {pending ? "Пересчитываю…" : "Пересчитать день"}
      </Button>
    </form>
  );
}
