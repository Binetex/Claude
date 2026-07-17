"use client";
import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  ownerSyncProducts,
  ownerSyncOrders,
  ownerGetSyncStatus,
  type SyncStatusSnapshot,
} from "@/app/dashboard/(owner)/actions";

type KindStatus = NonNullable<SyncStatusSnapshot["products"]>;

function ProgressLine({ label, s }: { label: string; s: KindStatus | null }) {
  if (!s) return null;
  if (s.status === "RUNNING") {
    return (
      <div className="text-xs text-slate-500">
        ⏳ {label}: {s.total != null ? `${s.processed} из ${s.total}` : `обработано ${s.processed}`}…
      </div>
    );
  }
  if (s.status === "ERROR") {
    return (
      <div className="text-xs text-red-600" title={s.errorMessage ?? undefined}>
        ✕ {label}: ошибка (новых {s.created}, обновлено {s.updated}, ошибок {s.errors})
      </div>
    );
  }
  return (
    <div className="text-xs text-emerald-700">
      ✓ {label}: новых {s.created}, обновлено {s.updated}, пропущено {s.skipped}, ошибок {s.errors}
    </div>
  );
}

export function SiteSyncControls({ siteId, initial }: { siteId: string; initial: SyncStatusSnapshot }) {
  const [status, setStatus] = useState<SyncStatusSnapshot>(initial);
  const [pending, start] = useTransition();
  const router = useRouter();
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const running = status.products?.status === "RUNNING" || status.orders?.status === "RUNNING";

  useEffect(() => {
    if (running && !timer.current) {
      timer.current = setInterval(async () => {
        const next = await ownerGetSyncStatus(siteId);
        setStatus(next);
        if (next.products?.status !== "RUNNING" && next.orders?.status !== "RUNNING") {
          if (timer.current) clearInterval(timer.current);
          timer.current = null;
          router.refresh();
        }
      }, 2500);
    }
    return () => {
      if (timer.current) {
        clearInterval(timer.current);
        timer.current = null;
      }
    };
  }, [running, siteId, router]);

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => start(async () => { await ownerSyncProducts(siteId); setStatus(await ownerGetSyncStatus(siteId)); })}
          disabled={pending || status.products?.status === "RUNNING"}
          className="rounded-md border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60"
        >
          Синхронизировать товары
        </button>
        <button
          onClick={() => start(async () => { await ownerSyncOrders(siteId); setStatus(await ownerGetSyncStatus(siteId)); })}
          disabled={pending || status.orders?.status === "RUNNING"}
          className="rounded-md border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60"
        >
          Синхронизировать заказы
        </button>
      </div>
      <ProgressLine label="Товары" s={status.products} />
      <ProgressLine label="Заказы" s={status.orders} />
    </div>
  );
}
