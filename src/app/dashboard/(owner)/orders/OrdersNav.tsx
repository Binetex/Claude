"use client";
import { createContext, useContext, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Spinner } from "@/components/ui/states";

/**
 * Навигация по фильтрам и страницам списка заказов с ВИДИМЫМ ожиданием.
 *
 * Страница заказов — force-dynamic, поэтому после клика по вкладке браузер ждёт ответ сервера,
 * ничего не показывая. loading.tsx тут не спасает: он срабатывает при входе в раздел, а не при
 * смене searchParams внутри уже открытого маршрута. Поэтому переход оборачивается в useTransition,
 * а pending раздаётся через контекст: фильтры и пейджер блокируются, список приглушается.
 *
 * Без провайдера хук работает автономно (локальный transition) — так страница колл-центра
 * использует тот же OrderFiltersBar без изменений.
 */
type Nav = { pending: boolean; go: (url: string) => void };

const NavCtx = createContext<Nav | null>(null);

export function useOrdersNav(): Nav {
  const ctx = useContext(NavCtx);
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  // Хуки вызываются всегда и в одном порядке; контекст лишь имеет приоритет над локальным состоянием.
  return ctx ?? { pending, go: (url: string) => startTransition(() => router.push(url)) };
}

export function OrdersNavProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const go = (url: string) => startTransition(() => router.push(url));

  return (
    <NavCtx.Provider value={{ pending, go }}>
      {pending && (
        <div className="fixed inset-x-0 top-0 z-50 h-0.5 animate-pulse bg-slate-900" role="status" aria-label="Загрузка" />
      )}
      {children}
    </NavCtx.Provider>
  );
}

/** Приглушает список, пока грузится следующая выборка, и гасит клики по устаревшим строкам. */
export function OrdersPendingArea({ children }: { children: ReactNode }) {
  const { pending } = useOrdersNav();
  return (
    <div className={pending ? "pointer-events-none opacity-40 transition-opacity" : "transition-opacity"}>
      {children}
    </div>
  );
}

/** Спиннер рядом с вкладками — чтобы ожидание было заметно и без взгляда на верх экрана. */
export function NavSpinner() {
  const { pending } = useOrdersNav();
  return pending ? <Spinner className="size-4" /> : null;
}
