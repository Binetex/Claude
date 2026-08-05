"use client";
/**
 * Недоступность флориста: выходные по дням недели и отдельные нерабочие даты.
 *
 * Оба блока читаются в одну сторону — «когда флорист НЕ работает». Даты ДОБАВЛЯЮТСЯ к
 * выходным, а не отменяют их. Раньше блок назывался «Исключения» и рядом с «Выходными»
 * читался ровно наоборот: как «в эти дни работает, несмотря на выходной».
 *
 * Обратного случая — «выйду в эту субботу, хотя обычно выходной» — сознательно нет: он
 * потребовал бы двух типов дат вместо одного, а спроса на него не было.
 *
 * Обе настройки сохраняются сразу по клику, без кнопки «Сохранить»: это переключатели и
 * список, а не форма, которую заполняют целиком.
 *
 * Даты хранятся как календарные дни («2026-08-15»), той же конвенцией, что и день доставки
 * заказа. Ни времени, ни диапазонов здесь нет намеренно — из них тут же выросло бы
 * расписание, которого просили не делать.
 */
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { WEEKDAYS } from "@/modules/assignments/availability";

type Result = { error?: string; message?: string };

export function AvailabilityEditor({
  floristId,
  weekendDays,
  daysOff,
  actions,
}: {
  floristId: string;
  weekendDays: number[];
  /** Календарные дни «YYYY-MM-DD», уже отсортированные. */
  daysOff: string[];
  actions: {
    setWeekends: (floristId: string, days: number[]) => Promise<Result>;
    addDayOff: (floristId: string, day: string) => Promise<Result>;
    removeDayOff: (floristId: string, day: string) => Promise<Result>;
  };
}) {
  const [pending, start] = useTransition();
  const [newDay, setNewDay] = useState("");

  const run = (fn: () => Promise<Result>) =>
    start(async () => {
      const r = await fn();
      if (r.error) toast.error(r.error);
      else toast.success(r.message ?? "Сохранено");
    });

  const toggle = (value: number, checked: boolean) => {
    const next = checked ? [...weekendDays, value] : weekendDays.filter((d) => d !== value);
    run(() => actions.setWeekends(floristId, next));
  };

  const add = () => {
    if (!newDay) return;
    run(() => actions.addDayOff(floristId, newDay));
    setNewDay("");
  };

  return (
    <div className="mt-3 rounded-lg border border-slate-200 p-3">
      <div className="text-xs font-semibold text-slate-600">Выходные</div>
      <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1.5">
        {WEEKDAYS.map((d) => (
          <label key={d.value} className="flex items-center gap-1.5 text-sm text-slate-600">
            <input
              type="checkbox"
              className="h-4 w-4"
              checked={weekendDays.includes(d.value)}
              disabled={pending}
              onChange={(e) => toggle(d.value, e.target.checked)}
            />
            {d.label}
          </label>
        ))}
      </div>

      <div className="mt-3 text-xs font-semibold text-slate-600">Нерабочие даты</div>
      {daysOff.length > 0 && (
        <ul className="mt-1.5 flex flex-wrap gap-1.5">
          {daysOff.map((d) => (
            <li
              key={d}
              className="flex items-center gap-1 rounded-md border border-slate-200 bg-slate-50 py-0.5 pr-0.5 pl-2 text-sm text-slate-700"
            >
              <span className="tabular-nums">{d.split("-").reverse().join(".")}</span>
              <Button
                variant="ghost"
                size="iconSm"
                aria-label={`Убрать ${d}`}
                disabled={pending}
                className="text-slate-400 hover:text-red-600"
                onClick={() => run(() => actions.removeDayOff(floristId, d))}
              >
                <X className="size-3.5" />
              </Button>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Input
          type="date"
          value={newDay}
          disabled={pending}
          onChange={(e) => setNewDay(e.target.value)}
          className="h-8 max-w-40"
        />
        <Button size="sm" variant="outline" disabled={pending || !newDay} onClick={add}>
          Добавить дату
        </Button>
      </div>

      <p className="mt-2 text-xs text-slate-400">
        В эти дни заказы автоматически уходят следующему флористу. Назначить вручную можно всегда.
      </p>
    </div>
  );
}
