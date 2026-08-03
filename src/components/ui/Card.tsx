import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";

export function Card({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("rounded-xl border border-slate-200 bg-white shadow-sm", className)}>
      {children}
    </div>
  );
}

export function CardHeader({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("border-b border-slate-100 px-4 py-3", className)}>{children}</div>;
}

/**
 * Заголовок карточки. Необязательная иконка — якорь для взгляда: на длинной странице
 * блоки различаются по значку быстрее, чем по тексту. Она декоративная (aria-hidden),
 * смысл несёт заголовок — иконка его не заменяет.
 */
export function CardTitle({
  children,
  className,
  icon: Icon,
}: {
  children: React.ReactNode;
  className?: string;
  icon?: LucideIcon;
}) {
  return (
    <h3 className={cn("flex items-center gap-2 text-sm font-semibold text-slate-700", className)}>
      {Icon && <Icon aria-hidden className="size-4 shrink-0 text-slate-400" />}
      {children}
    </h3>
  );
}

export function CardBody({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("px-4 py-3", className)}>{children}</div>;
}
