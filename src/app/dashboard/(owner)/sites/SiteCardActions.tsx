"use client";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { ownerCheckConnection, ownerDisconnectSite, ownerRegisterWebhooks } from "./actions";

/** Действия карточки Custom App: Проверить подключение / Проверить подписки / Отключить. */
export function SiteCardActions({ siteId }: { siteId: string }) {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={pending}
          onClick={() =>
            start(async () => {
              const res = await ownerCheckConnection(siteId);
              setMsg(res?.ok ? { ok: true, text: res.message ?? "OK" } : { ok: false, text: res?.error ?? "Ошибка" });
            })
          }
        >
          {pending ? "…" : "Проверить подключение"}
        </Button>

        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={pending}
          title="Сверяет подписки на webhook с Shopify и создаёт недостающие. Без них заказы не приходят."
          onClick={() =>
            start(async () => {
              const res = await ownerRegisterWebhooks(siteId);
              setMsg(res?.ok ? { ok: true, text: res.message ?? "OK" } : { ok: false, text: res?.error ?? "Ошибка" });
            })
          }
        >
          {pending ? "…" : "Проверить подписки"}
        </Button>

        {confirmDisconnect ? (
          <>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              disabled={pending}
              onClick={() => start(async () => { await ownerDisconnectSite(siteId); setConfirmDisconnect(false); })}
            >
              Точно отключить?
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setConfirmDisconnect(false)}>Отмена</Button>
          </>
        ) : (
          <Button type="button" variant="ghost" size="sm" onClick={() => setConfirmDisconnect(true)}>Отключить</Button>
        )}
      </div>
      {msg && <p className={msg.ok ? "text-xs text-emerald-700" : "text-xs text-red-600"}>{msg.text}</p>}
      <p className="text-[11px] text-slate-400">Отключение сохраняет историю заказов и товары; удаляет только credentials и webhooks.</p>
    </div>
  );
}
