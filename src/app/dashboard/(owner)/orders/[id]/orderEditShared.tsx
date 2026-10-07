"use client";
import { useTransition } from "react";
import { toast } from "sonner";
import { saveOrderBlock, type SaveOrderBlockResult } from "@/modules/orders/editActions";
import type { OrderBlock, BlockFormData } from "@/modules/orders/updateOrderBlock";

/**
 * Общая клиентская логика редактирования блока заказа. Используется во всех редактируемых блоках
 * (owner/call-center/florist) — единый путь и UX.
 *
 * Сверки версии («заказ изменён другим пользователем») нет (владелец 07.10.2026): версия была одна
 * на весь заказ, а его постоянно трогает сама система, и сохранение проходило с N-го нажатия.
 * Вместо неё формы присылают ТОЛЬКО изменённые поля — то, чего человек не трогал, не перетрётся
 * его устаревшей копией.
 */

function errorText(res: Exclude<SaveOrderBlockResult, { status: "ok" }>): string {
  switch (res.status) {
    case "forbidden": return "Нет прав на редактирование этого заказа.";
    case "notfound": return "Заказ не найден.";
    case "invalid": return res.error;
  }
}

export function useBlockSave(orderId: string, block: OrderBlock) {
  const [pending, start] = useTransition();

  function save(data: BlockFormData, opts?: { successMessage?: string; onOk?: () => void }) {
    start(async () => {
      const res = await saveOrderBlock(orderId, block, data);
      if (res.status === "ok") {
        if (opts?.successMessage) toast.success(opts.successMessage);
        opts?.onOk?.();
      } else {
        toast.error(errorText(res));
      }
    });
  }

  return { pending, save };
}
