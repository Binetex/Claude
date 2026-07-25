"use client";
import * as React from "react";
import type { DateRange } from "react-day-picker";
import { CalendarDays, X } from "lucide-react";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";

/**
 * Выбор диапазона дат одной кнопкой-поповером.
 *
 * Наружу отдаёт даты строками «YYYY-MM-DD» — ровно в том виде, в каком их ждут фильтры и URL.
 * Разбор/сборка идёт по календарным полям, БЕЗ таймзонных преобразований: Date создаётся
 * локальным конструктором, а обратно собирается из getFullYear/getMonth/getDate. Через
 * toISOString() день мог бы сместиться на сутки у пользователя западнее UTC.
 */
export type DateRangeValue = { from?: string; to?: string };

const pad = (n: number) => String(n).padStart(2, "0");

export function toYmd(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function fromYmd(s?: string): Date | undefined {
  if (!s) return undefined;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return undefined;
  const [y, mo, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const d = new Date(y, mo - 1, day);
  if (Number.isNaN(d.getTime())) return undefined;
  // Date молча переполняет несуществующие значения: 2026-13-45 → февраль 2027, а 2026-02-31 →
  // 3 марта. Значение приходит из URL, поэтому сверяем, что дата осталась ровно той же.
  if (d.getFullYear() !== y || d.getMonth() !== mo - 1 || d.getDate() !== day) return undefined;
  return d;
}

const fmt = new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "short" });

/** Подпись на кнопке: «12 июл. – 18 июл.», «с 12 июл.», «по 18 июл.» или плейсхолдер. */
export function rangeLabel(value: DateRangeValue, placeholder: string): string {
  const from = fromYmd(value.from);
  const to = fromYmd(value.to);
  if (from && to) return from.getTime() === to.getTime() ? fmt.format(from) : `${fmt.format(from)} – ${fmt.format(to)}`;
  if (from) return `с ${fmt.format(from)}`;
  if (to) return `по ${fmt.format(to)}`;
  return placeholder;
}

export function DateRangePicker({
  value,
  onChange,
  disabled,
  placeholder = "Даты доставки",
  className,
}: {
  value: DateRangeValue;
  onChange: (next: DateRangeValue) => void;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const selected: DateRange | undefined = React.useMemo(() => {
    const from = fromYmd(value.from);
    const to = fromYmd(value.to);
    return from || to ? { from, to } : undefined;
  }, [value.from, value.to]);

  const hasValue = !!(value.from || value.to);

  function handleSelect(range: DateRange | undefined, triggerDate: Date) {
    // Если период уже выбран целиком, следующий клик НАЧИНАЕТ новый, а не растягивает старый.
    // Иначе выбор «с 6 июля» поверх «20–25 июля» молча превращался в «6–25 июля».
    if (value.from && value.to) {
      onChange({ from: toYmd(triggerDate), to: undefined });
      return;
    }
    const next = { from: range?.from ? toYmd(range.from) : undefined, to: range?.to ? toYmd(range.to) : undefined };
    onChange(next);
    // Закрываем, когда период завершён: первый клик — начало, второй — конец.
    if (next.from && next.to) setOpen(false);
  }

  return (
    <div className={cn("flex items-center gap-1", className)}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            disabled={disabled}
            className={cn("justify-start font-normal", !hasValue && "text-slate-500")}
          >
            <CalendarDays />
            {rangeLabel(value, placeholder)}
          </Button>
        </PopoverTrigger>
        <PopoverContent>
          <Calendar
            mode="range"
            selected={selected}
            onSelect={handleSelect}
            defaultMonth={fromYmd(value.from) ?? new Date()}
            numberOfMonths={1}
            // Два месяца рядом — только когда есть место (на телефоне это горизонтальный скролл).
            className="sm:[&_.rdp-months]:flex-row"
          />
          <div className="mt-2 flex items-center justify-between border-t border-slate-100 pt-2">
            <span className="text-[11px] text-slate-400">Выберите начало и конец периода</span>
            <Button
              size="sm"
              variant="ghost"
              disabled={!hasValue}
              onClick={() => {
                onChange({ from: undefined, to: undefined });
                setOpen(false);
              }}
            >
              Сбросить
            </Button>
          </div>
        </PopoverContent>
      </Popover>

      {hasValue && (
        <button
          type="button"
          disabled={disabled}
          onClick={() => onChange({ from: undefined, to: undefined })}
          aria-label="Очистить даты"
          className="rounded-md p-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
        >
          <X className="size-4" />
        </button>
      )}
    </div>
  );
}
