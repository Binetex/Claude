"use client";
import * as React from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import { cn } from "@/lib/cn";

/**
 * Поповер дизайн-системы. Стилистика повторяет dialog.tsx (slate, rounded-xl, тонкая рамка),
 * чтобы всплывающие панели выглядели единообразно. Новый компонент — существующие не трогаем.
 */
export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;
export const PopoverAnchor = PopoverPrimitive.Anchor;

export function PopoverContent({
  className,
  align = "start",
  sideOffset = 6,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        align={align}
        sideOffset={sideOffset}
        className={cn(
          // Без animate-in/fade-in: эти утилиты даёт плагин tailwindcss-animate, которого
          // в проекте нет. Тянуть плагин ради появления поповера — глобальное изменение.
          "z-50 w-auto rounded-xl border border-slate-200 bg-white p-3 shadow-lg outline-none",
          className
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
}
