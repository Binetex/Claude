"use client";
/**
 * Стрелки «выше/ниже» на плашке заказа.
 *
 * Стрелки, а не перетаскивание: день расставляют с телефона на ходу, а drag-and-drop на
 * телефоне спорит с прокруткой списка и промахивается пальцем. Нажатие попадает всегда.
 *
 * `z-10` обязателен: плашка целиком — ссылка в заказ (растянутая after:inset-0), и без подъёма
 * над ней нажатие на стрелку открывало бы карточку вместо перестановки.
 */
import { useTransition } from "react";
import { toast } from "sonner";
import { moveOrderAction } from "./reorderActions";

export function OrderQueueArrows({ orderId, visibleIds, position }: { orderId: string; visibleIds: string[]; position: "first" | "last" | "middle" | "only" }) {
  const [pending, start] = useTransition();

  const move = (direction: "up" | "down") =>
    start(async () => {
      const res = await moveOrderAction(orderId, direction, visibleIds);
      if (res.error) toast.error(res.error);
    });

  const cls = "flex h-5 w-6 items-center justify-center rounded border border-slate-200 bg-white text-[10px] leading-none text-slate-500 hover:bg-slate-50 disabled:opacity-30";
  return (
    <div className="relative z-10 flex flex-col gap-0.5" onClick={(e) => e.stopPropagation()}>
      <button type="button" className={cls} aria-label="Делать раньше" disabled={pending || position === "first" || position === "only"} onClick={() => move("up")}>
        ▲
      </button>
      <button type="button" className={cls} aria-label="Делать позже" disabled={pending || position === "last" || position === "only"} onClick={() => move("down")}>
        ▼
      </button>
    </div>
  );
}
