"use client";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ownerSetSiteStorefrontDomain } from "./actions";

/**
 * «Домен витрины» (Site.storefrontDomain) — адрес, который ассистент даёт клиенту в ссылке на
 * товар. У Shopify каталог хранит служебный `*.myshopify.com`, и показывать его наружу нельзя.
 * Обычно домен приезжает сам при проверке подключения; здесь его можно задать руками.
 */
export function SiteStorefrontDomainSetting({ siteId, current }: { siteId: string; current: string | null }) {
  const [value, setValue] = useState(current ?? "");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();

  return (
    <div className="space-y-1.5 border-t border-slate-100 pt-3">
      <div className="text-xs text-slate-400">Домен витрины (ссылки клиенту)</div>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={value}
          onChange={(e) => { setValue(e.target.value); setMsg(null); }}
          placeholder="paradiseflowersart.com"
          className="max-w-[18rem]"
          aria-label="Домен витрины"
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={pending || value.trim() === (current ?? "")}
          onClick={() =>
            start(async () => {
              const r = await ownerSetSiteStorefrontDomain(siteId, value);
              setMsg(r?.ok ? { ok: true, text: r.message ?? "Сохранено" } : { ok: false, text: r?.error ?? "Ошибка" });
            })
          }
        >
          {pending ? "…" : "Сохранить домен"}
        </Button>
      </div>
      <p className="text-xs text-slate-500">
        {current
          ? "Ассистент даёт клиенту ссылки на товары на этом домене."
          : "Не задан: ассистент отвечает без ссылок на товары, чтобы не показать служебный домен магазина."}
      </p>
      {msg && <p className={msg.ok ? "text-xs text-emerald-700" : "text-xs text-red-600"}>{msg.text}</p>}
    </div>
  );
}
