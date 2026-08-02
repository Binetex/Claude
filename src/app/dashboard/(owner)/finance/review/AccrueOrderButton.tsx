"use client";
/** Ручной запуск начисления по заказу. Идемпотентно: повтор не создаёт вторую запись. */
import { useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ownerAccrueOrder } from "@/app/dashboard/(owner)/finance/financeActions";

export function AccrueOrderButton({ orderId }: { orderId: string }) {
  const [pending, start] = useTransition();

  return (
    <Button
      size="sm"
      variant="outline"
      disabled={pending}
      onClick={() =>
        start(async () => {
          const res = await ownerAccrueOrder(orderId);
          if (res.error) toast.error(res.error);
          else toast.success(res.message ?? "Готово");
        })
      }
    >
      {pending ? "…" : "Начислить"}
    </Button>
  );
}
