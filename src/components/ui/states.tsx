import { cn } from "@/lib/cn";

/**
 * Общие состояния списков/секций: пусто / ошибка / загрузка. Единый визуальный язык
 * (см. docs/DESIGN_SYSTEM.md), чтобы не дублировать разметку по страницам. Презентационные,
 * без хуков — работают и в Server Components.
 */

export function EmptyState({
  title = "Ничего не найдено",
  description,
  icon,
  action,
  className,
}: {
  title?: string;
  description?: React.ReactNode;
  icon?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center gap-2 py-8 text-center", className)}>
      {icon ? <div className="text-slate-300 [&_svg]:size-8">{icon}</div> : null}
      <div className="text-sm text-slate-400">{title}</div>
      {description ? <div className="max-w-sm text-xs text-slate-400">{description}</div> : null}
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}

export function ErrorState({
  title = "Что-то пошло не так",
  description,
  action,
  className,
}: {
  title?: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      role="alert"
      className={cn(
        "flex flex-col items-center justify-center gap-2 rounded-lg border border-red-200 bg-red-50 py-8 text-center",
        className
      )}
    >
      <div className="text-sm font-medium text-red-700">{title}</div>
      {description ? <div className="max-w-sm text-xs text-red-600">{description}</div> : null}
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}

/** Крутящийся индикатор загрузки. `aria-label` для скринридеров. */
export function Spinner({ className, label = "Загрузка" }: { className?: string; label?: string }) {
  return (
    <span
      role="status"
      aria-label={label}
      className={cn(
        "inline-block size-4 animate-spin rounded-full border-2 border-slate-300 border-t-slate-600",
        className
      )}
    />
  );
}

/** Скелетон-плейсхолдер под контент во время загрузки. Декоративный (скрыт от скринридера). */
export function Skeleton({ className }: { className?: string }) {
  return <span aria-hidden className={cn("block animate-pulse rounded-md bg-slate-100", className)} />;
}

export function LoadingState({ label = "Загрузка…", className }: { label?: string; className?: string }) {
  return (
    <div className={cn("flex items-center justify-center gap-2 py-8 text-sm text-slate-400", className)}>
      <Spinner />
      <span>{label}</span>
    </div>
  );
}

/** Скелетон списка карточек — плейсхолдер контента дашборда во время загрузки маршрута. */
export function CardListSkeleton({ rows = 5, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn("space-y-3", className)} aria-hidden>
      <Skeleton className="h-8 w-40" />
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="flex items-center gap-4">
            <Skeleton className="h-[60px] w-[60px] rounded" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-1/3" />
              <Skeleton className="h-3 w-1/2" />
            </div>
            <Skeleton className="h-4 w-16" />
          </div>
        </div>
      ))}
    </div>
  );
}
