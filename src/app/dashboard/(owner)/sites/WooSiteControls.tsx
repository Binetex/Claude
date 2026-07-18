"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { ownerCheckWoo, ownerDisconnectWoo, ownerRegisterWooWebhooks, ownerSyncWoo, ownerFullSyncWoo } from "./wooActions";
import type { SyncStatusSnapshot } from "@/app/dashboard/(owner)/actions";

type KindStatus = NonNullable<SyncStatusSnapshot["products"]>;

function ProgressLine({ label, s }: { label: string; s: KindStatus | null }) {
  if (!s) return null;
  if (s.status === "RUNNING") return <div className="text-xs text-slate-500">⏳ {label}: {s.total != null ? `${s.processed} из ${s.total}` : `обработано ${s.processed}`}…</div>;
  if (s.status === "ERROR") return <div className="text-xs text-red-600" title={s.errorMessage ?? undefined}>✕ {label}: ошибка (новых {s.created}, обновлено {s.updated}, ошибок {s.errors})</div>;
  return <div className="text-xs text-emerald-700">✓ {label}: новых {s.created}, обновлено {s.updated}, пропущено {s.skipped}, ошибок {s.errors}</div>;
}

/** Действия карточки WooCommerce: проверка/webhooks/синхронизация/отключение. */
export function WooSiteControls({ siteId, snapshot, connected, storeUrl }: { siteId: string; snapshot: SyncStatusSnapshot; connected: boolean; storeUrl: string }) {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [confirmFull, setConfirmFull] = useState(false);
  const router = useRouter();

  const run = (fn: () => Promise<{ ok?: boolean; error?: string; message?: string } | null | void>) =>
    start(async () => {
      const res = (await fn()) ?? null;
      if (res) setMsg(res.ok ? { ok: true, text: res.message ?? "OK" } : { ok: false, text: res.error ?? "Ошибка" });
      router.refresh();
    });

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" size="sm" disabled={pending} onClick={() => run(() => ownerCheckWoo(siteId))}>
          Проверить
        </Button>
        {connected && (
          <>
            <Button type="button" variant="outline" size="sm" disabled={pending} onClick={() => run(() => ownerRegisterWooWebhooks(siteId))}>
              Настроить webhooks
            </Button>
            <Button type="button" variant="outline" size="sm" disabled={pending} onClick={() => run(() => ownerSyncWoo(siteId, "PRODUCTS"))}>
              Синхронизировать товары
            </Button>
            <Button type="button" variant="outline" size="sm" disabled={pending} onClick={() => run(() => ownerSyncWoo(siteId, "ORDERS"))}>
              Синхронизировать заказы
            </Button>
            {confirmFull ? (
              <>
                <Button type="button" variant="destructive" size="sm" disabled={pending} onClick={() => run(async () => { const r = await ownerFullSyncWoo(siteId); setConfirmFull(false); return r; })}>
                  Импортировать ВСЮ историю?
                </Button>
                <Button type="button" variant="ghost" size="sm" onClick={() => setConfirmFull(false)}>Отмена</Button>
              </>
            ) : (
              <Button type="button" variant="outline" size="sm" disabled={pending} onClick={() => setConfirmFull(true)}>
                Полная синхронизация
              </Button>
            )}
          </>
        )}
        <a href={`${storeUrl}/wp-admin`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center rounded-md border border-slate-300 px-2.5 py-1.5 text-sm text-slate-600 hover:bg-slate-50">
          Открыть WP Admin
        </a>
        {confirmDisconnect ? (
          <>
            <Button type="button" variant="destructive" size="sm" disabled={pending} onClick={() => run(async () => { await ownerDisconnectWoo(siteId); setConfirmDisconnect(false); })}>
              Точно отключить?
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setConfirmDisconnect(false)}>Отмена</Button>
          </>
        ) : (
          <Button type="button" variant="ghost" size="sm" onClick={() => setConfirmDisconnect(true)}>Отключить</Button>
        )}
      </div>
      <ProgressLine label="Товары" s={snapshot.products} />
      <ProgressLine label="Заказы" s={snapshot.orders} />
      {msg && <p className={msg.ok ? "text-xs text-emerald-700" : "text-xs text-red-600"}>{msg.text}</p>}
      <p className="text-[11px] text-slate-400">
        «Синхронизировать заказы» — инкрементально: первый раз последние 14 дней, далее только изменения после прошлой синхронизации.
        «Полная синхронизация» — импорт ВСЕЙ истории заказов (по подтверждению). Отключение сохраняет историю; удаляет только credentials и webhooks.
      </p>
    </div>
  );
}
