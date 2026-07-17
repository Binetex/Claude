import * as React from "react";
import { cn } from "@/lib/cn";

/** Единое поле ввода дизайн-системы Floremart (высота 36px, консистентный фокус). */
export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type, ...props }, ref) => (
    <input
      type={type}
      ref={ref}
      className={cn(
        "flex h-9 w-full rounded-lg border border-slate-200 bg-white px-3 py-1 text-sm text-slate-900 shadow-xs transition-colors",
        "placeholder:text-slate-400 focus-visible:border-slate-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-200",
        "disabled:cursor-not-allowed disabled:opacity-60",
        className
      )}
      {...props}
    />
  )
);
Input.displayName = "Input";
