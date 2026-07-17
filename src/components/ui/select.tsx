import * as React from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/cn";

/** Стилизованный нативный select дизайн-системы (высота 36px, единый фокус, шеврон). */
export const Select = React.forwardRef<
  HTMLSelectElement,
  React.SelectHTMLAttributes<HTMLSelectElement> & { wrapperClassName?: string }
>(({ className, wrapperClassName, children, ...props }, ref) => (
    <div className={cn("relative w-full", wrapperClassName)}>
      <select
        ref={ref}
        className={cn(
          "h-9 w-full cursor-pointer appearance-none rounded-lg border border-slate-200 bg-white pl-3 pr-8 text-sm text-slate-800 shadow-xs transition-colors",
          "focus-visible:border-slate-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-200 disabled:cursor-not-allowed disabled:opacity-60",
          className
        )}
        {...props}
      >
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
    </div>
  )
);
Select.displayName = "Select";
