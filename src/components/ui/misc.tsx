import * as React from "react";
import { cn } from "@/lib/cn";

/** Тонкий разделитель. */
export function Separator({ className }: { className?: string }) {
  return <div className={cn("h-px w-full bg-slate-100", className)} />;
}

/** Скелетон загрузки. */
export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded-md bg-slate-100", className)} />;
}

/** Единый заголовок страницы: title + описание + слот действий справа. */
export function PageHeader({
  title,
  description,
  actions,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-lg font-semibold text-slate-900">{title}</h1>
        {description && <p className="mt-0.5 text-sm text-slate-500">{description}</p>}
      </div>
      {actions && <div className="flex flex-shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

/** Компактная метрика-карточка. Тон-акцент — только когда это осмысленно. */
export function StatCard({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: React.ReactNode;
  tone?: "default" | "danger" | "warning" | "success" | "info";
}) {
  const toneCls = {
    default: "text-slate-900",
    danger: "text-red-600",
    warning: "text-amber-600",
    success: "text-emerald-600",
    info: "text-blue-600",
  }[tone];
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-xs">
      <div className="text-[11px] font-medium tracking-wide text-slate-400 uppercase">{label}</div>
      <div className={cn("mt-1.5 text-2xl font-semibold tabular-nums", toneCls)}>{value}</div>
    </div>
  );
}

/** Единое пустое состояние. */
export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-4 py-12 text-center">
      {icon && <div className="text-slate-300 [&_svg]:size-8">{icon}</div>}
      <div className="text-sm font-medium text-slate-600">{title}</div>
      {description && <div className="max-w-sm text-xs text-slate-400">{description}</div>}
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}
