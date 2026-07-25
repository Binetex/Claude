"use client";
import * as React from "react";
import { DayPicker } from "react-day-picker";
import { ru } from "react-day-picker/locale";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/cn";
import { buttonVariants } from "@/components/ui/button";

/**
 * Календарь в раскладке официального shadcn Range Calendar, но на палитре проекта.
 *
 * Классы shadcn (bg-primary, text-muted-foreground, bg-accent, border-input) опираются на их
 * набор CSS-переменных — в этом проекте объявлены только --background/--foreground, а вся
 * палитра задана напрямую через slate. Поэтому раскладка и размеры взяты как есть, а цвета
 * переведены на slate — без правки globals.css и без темы shadcn.
 *
 * Стрелки навигации используют существующий buttonVariants (variant="ghost"), чтобы не
 * заводить вторую кнопку.
 */
export type CalendarProps = React.ComponentProps<typeof DayPicker>;

export function Calendar({ className, classNames, showOutsideDays = true, ...props }: CalendarProps) {
  return (
    <DayPicker
      locale={ru}
      showOutsideDays={showOutsideDays}
      className={cn("p-1", className)}
      classNames={{
        // В react-day-picker v10 nav — СОСЕД месяца внутри months, а не потомок месяца.
        // Поэтому растягиваем его поверх строки заголовка: months получает relative,
        // nav — absolute на всю ширину, а кнопки расходятся по краям обычным flex.
        months: "relative flex flex-col gap-4 sm:flex-row",
        month: "flex flex-col gap-3",
        month_caption: "flex h-8 items-center justify-center",
        caption_label: "text-sm font-medium text-slate-900 capitalize",
        nav: "absolute inset-x-0 top-0 z-10 flex h-8 items-center justify-between px-1",
        button_previous: cn(buttonVariants({ variant: "ghost" }), "size-7 p-0 text-slate-500 hover:text-slate-900"),
        button_next: cn(buttonVariants({ variant: "ghost" }), "size-7 p-0 text-slate-500 hover:text-slate-900"),
        month_grid: "w-full border-collapse",
        weekdays: "flex",
        weekday: "w-9 text-[11px] font-normal text-slate-400",
        week: "mt-1 flex w-full",
        day: cn(
          "relative size-9 p-0 text-center text-sm",
          // Скругление концов диапазона и заливка середины — этим range и «читается».
          "[&:has([aria-selected])]:bg-slate-100",
          "[&:has(>.day-range-start)]:rounded-l-md [&:has(>.day-range-end)]:rounded-r-md",
          "first:[&:has([aria-selected])]:rounded-l-md last:[&:has([aria-selected])]:rounded-r-md"
        ),
        day_button: cn(
          "size-9 rounded-md p-0 font-normal text-slate-700 transition-colors",
          "hover:bg-slate-100 hover:text-slate-900",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400/60"
        ),
        range_start: "day-range-start rounded-l-md bg-slate-900 text-white hover:bg-slate-800 [&>button]:bg-slate-900 [&>button]:text-white [&>button:hover]:bg-slate-800",
        range_end: "day-range-end rounded-r-md bg-slate-900 text-white hover:bg-slate-800 [&>button]:bg-slate-900 [&>button]:text-white [&>button:hover]:bg-slate-800",
        // В режиме range класс selected висит на КАЖДОМ дне диапазона, включая середину,
        // и его белый текст делал числа невидимыми на светлой заливке. Середина перебивает
        // его явно (важность), поэтому порядок правил в собранном CSS роли не играет.
        range_middle: "bg-slate-100 [&>button]:!bg-transparent [&>button]:!text-slate-900",
        selected: "[&>button]:bg-slate-900 [&>button]:text-white",
        today: "[&>button]:font-semibold [&>button]:text-sky-600",
        outside: "[&>button]:text-slate-300",
        disabled: "[&>button]:text-slate-300 [&>button]:pointer-events-none",
        hidden: "invisible",
        ...classNames,
      }}
      components={{
        Chevron: ({ orientation, ...rest }) =>
          orientation === "left" ? <ChevronLeft className="size-4" {...rest} /> : <ChevronRight className="size-4" {...rest} />,
      }}
      {...props}
    />
  );
}
