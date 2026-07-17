"use client";
import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  ownerSyncAllProducts,
  ownerGetProductsSyncSummary,
  type ProductsSyncSummary,
} from "@/app/dashboard/(owner)/actions";

export function SyncProductsBar({ initial }: { initial: ProductsSyncSummary }) {
  const [summary, setSummary] = useState<ProductsSyncSummary>(initial);
  const [pending, start] = useTransition();
  const router = useRouter();
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    const running = summary?.status === "RUNNING";
    if (running && !timer.current) {
      timer.current = setInterval(async () => {
        const next = await ownerGetProductsSyncSummary();
        setSummary(next);
        if (next?.status !== "RUNNING") {
          if (timer.current) clearInterval(timer.current);
          timer.current = null;
          router.refresh(); // подтянуть свежие товары в таблицу
        }
      }, 2500);
    }
    return () => {
      if (timer.current) {
        clearInterval(timer.current);
        timer.current = null;
      }
    };
  }, [summary?.status, router]);

  function sync() {
    start(async () => {
      await ownerSyncAllProducts();
      setSummary(await ownerGetProductsSyncSummary());
    });
  }

  const running = summary?.status === "RUNNING";

  return (
    <div className="flex flex-wrap items-center gap-3">
      <button
        onClick={sync}
        disabled={pending || running}
        className="rounded-md bg-slate-800 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-60"
      >
        {running ? "Синхронизация…" : "Синхронизировать товары"}
      </button>

      {summary && (
        <span className="text-sm text-slate-500">
          {running ? (
            <>
              ⏳ Идёт синхронизация…{" "}
              {summary.total != null
                ? `импортировано ${summary.processed} из ${summary.total}`
                : `обработано ${summary.processed}`}
            </>
          ) : summary.status === "ERROR" ? (
            <span className="text-red-600">
              ✕ Синхронизация с ошибками — новых: {summary.created}, обновлено: {summary.updated}, ошибок: {summary.errors}
            </span>
          ) : (
            <span className="text-emerald-700">
              ✓ Импорт завершён — новых: {summary.created}, обновлено: {summary.updated}, пропущено: {summary.skipped}, ошибок: {summary.errors}
            </span>
          )}
        </span>
      )}
    </div>
  );
}
