"use client";
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Button } from "@/components/ui/button";
import { ownerBulkFillActiveOrderCompositions } from "@/app/dashboard/(owner)/actions";

/**
 * Владелец: массово заполнить пустые составы позиций активных заказов из текущих составов
 * вариантов. Подтверждение через модалку.
 */
export function BulkFillCompositions() {
  const [pending, start] = useTransition();
  const router = useRouter();

  function run() {
    start(async () => {
      const { updated } = await ownerBulkFillActiveOrderCompositions();
      toast.success(`Обновлено позиций: ${updated}`);
      router.refresh();
    });
  }

  return (
    <ConfirmDialog
      title="Обновить составы активных заказов?"
      description="Заполнит пустые составы у активных заказов из текущих составов вариантов. Уже заполненные не изменятся."
      confirmLabel="Обновить"
      onConfirm={run}
      trigger={
        <Button variant="outline" size="icon" disabled={pending} title="Обновить составы активных заказов">
          <RefreshCw className={pending ? "animate-spin" : ""} />
        </Button>
      }
    />
  );
}
