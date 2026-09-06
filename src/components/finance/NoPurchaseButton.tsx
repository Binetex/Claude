"use client";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import type { ExpenseActions } from "./FlowerExpenseForms";

/** Пометка в строке расхода: через месяц должно быть видно, что ноль — это выходной, а не забытая закупка. */
export const NO_PURCHASE_COMMENT = "Закупки не было";

/**
 * «Закупки не было» — подтверждённый ноль за прошедший день одним нажатием, прямо из списка.
 *
 * Нужна флористу, который не работает по средам и выходным: заказы в такие дни доставляются
 * (букеты собраны накануне), и без записи день висит «не внесено» и не считается. Кнопка
 * ставит 0 тем же действием, что и обычный ввод, только без формы. Второе нажатие — защита от
 * случайного клика: ноль по дню, где закупка была, завышает прибыль и долю флориста.
 * Массового «обнулить всё» нет намеренно: решение по каждому дню должно быть осознанным.
 */
export function NoPurchaseButton({ actions, day, className }: { actions: ExpenseActions; day: string; className?: string }) {
  const [armed, setArmed] = useState(false);
  const [pending, start] = useTransition();

  if (!armed) {
    return (
      <Button type="button" size="sm" variant="outline" className={className} disabled={pending} onClick={() => setArmed(true)}>
        Закупки не было
      </Button>
    );
  }
  return (
    <span className="inline-flex items-center gap-1">
      <Button
        type="button"
        size="sm"
        variant="default"
        className={className}
        disabled={pending}
        onClick={() =>
          start(async () => {
            const fd = new FormData();
            fd.set("day", day);
            fd.set("amount", "0");
            fd.set("comment", NO_PURCHASE_COMMENT);
            const res = await actions.save(fd);
            setArmed(false);
            if (res.error) toast.error(res.error);
            else toast.success(res.message ?? `За ${day} записан ноль.`);
          })
        }
      >
        Поставить 0 за {day}
      </Button>
      <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => setArmed(false)}>
        Отмена
      </Button>
    </span>
  );
}
