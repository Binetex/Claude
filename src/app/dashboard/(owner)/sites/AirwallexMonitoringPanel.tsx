"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { ownerSaveAirwallex, ownerVerifyAirwallex, ownerToggleAirwallexMonitoring } from "./wooActions";
import type { AirwallexSettingsView } from "@/integrations/airwallex/settings";

/**
 * Пер-сайтовая настройка Airwallex Payment Monitoring. Credentials обратно не показываются;
 * включить мониторинг можно только после успешного Verify.
 */
export function AirwallexMonitoringPanel({ siteId, initial }: { siteId: string; initial: AirwallexSettingsView }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  // Поля credential всегда пустые: существующие значения наружу не отдаются.
  const [clientId, setClientId] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [env, setEnv] = useState(initial.env);
  const [threshold, setThreshold] = useState(String(initial.pendingThresholdMin));
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const verified = !!initial.verifiedAt;

  function run(fn: () => Promise<{ ok?: boolean; message?: string; error?: string } | null>) {
    setMsg(null);
    start(async () => {
      const r = await fn();
      setMsg(r?.error ? { ok: false, text: r.error } : { ok: true, text: r?.message ?? "Готово" });
      router.refresh();
    });
  }

  return (
    <div className="space-y-2 rounded-md border border-slate-200 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold text-slate-600">Airwallex Payment Monitoring</span>
        {initial.clientIdConfigured && initial.apiKeyConfigured ? (
          <span className="rounded border border-emerald-200 bg-emerald-50 px-1.5 py-px text-[11px] text-emerald-700">Ключи заданы</span>
        ) : (
          <span className="rounded border border-slate-200 bg-slate-50 px-1.5 py-px text-[11px] text-slate-500">Не настроено</span>
        )}
        {verified && <span className="rounded border border-sky-200 bg-sky-50 px-1.5 py-px text-[11px] text-sky-700">Проверено{initial.env === "demo" ? " · demo" : ""}</span>}
      </div>

      {!initial.cryptoConfigured && (
        <div className="rounded-md border border-red-200 bg-red-50 p-2 text-[11px] text-red-700">
          На сервере не задан ключ шифрования — сохранить credentials не получится.
        </div>
      )}

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <input
          type="password" autoComplete="new-password" value={clientId} onChange={(e) => setClientId(e.target.value)}
          placeholder={initial.clientIdConfigured ? "Client ID настроен — пусто = не менять" : "Airwallex Client ID"}
          className="rounded-md border border-slate-300 px-2 py-1.5 text-sm"
        />
        <input
          type="password" autoComplete="new-password" value={apiKey} onChange={(e) => setApiKey(e.target.value)}
          placeholder={initial.apiKeyConfigured ? `API Key ${initial.apiKeyMask ?? "настроен"} — пусто = не менять` : "Airwallex API Key"}
          className="rounded-md border border-slate-300 px-2 py-1.5 text-sm"
        />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1 text-xs text-slate-500">
          Окружение
          <select value={env} onChange={(e) => setEnv(e.target.value as "prod" | "demo")} className="rounded-md border border-slate-300 px-1.5 py-1 text-sm">
            <option value="prod">production</option>
            <option value="demo">demo</option>
          </select>
        </label>
        <label className="flex items-center gap-1 text-xs text-slate-500">
          Порог pending, мин
          <input type="number" min={1} value={threshold} onChange={(e) => setThreshold(e.target.value)} className="w-20 rounded-md border border-slate-300 px-1.5 py-1 text-sm" />
        </label>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={pending} onClick={() => run(async () => {
          const fd = new FormData();
          fd.set("siteId", siteId); fd.set("airwallexClientId", clientId); fd.set("airwallexApiKey", apiKey);
          fd.set("airwallexApiEnv", env); fd.set("airwallexPendingThresholdMin", threshold);
          return ownerSaveAirwallex(null, fd);
        })}>Сохранить</Button>
        <Button size="sm" variant="outline" disabled={pending || !(initial.clientIdConfigured && initial.apiKeyConfigured)} onClick={() => run(() => ownerVerifyAirwallex(siteId))}>
          Verify connection
        </Button>
        <label className="flex items-center gap-1.5 text-xs text-slate-600">
          <input
            type="checkbox" className="h-4 w-4" checked={initial.monitoringEnabled}
            disabled={pending || (!verified && !initial.monitoringEnabled)}
            onChange={(e) => run(() => ownerToggleAirwallexMonitoring(siteId, e.target.checked))}
          />
          {initial.monitoringEnabled ? "мониторинг включён" : "мониторинг выключен"}
        </label>
        {msg && <span className={msg.ok ? "text-xs text-emerald-700" : "text-xs text-red-600"}>{msg.text}</span>}
      </div>

      <p className="text-[11px] text-slate-400">
        {verified
          ? `Проверено ${new Date(initial.verifiedAt!).toLocaleString("ru-RU")}. Мониторинг только читает статус платежа — заказы в работу не переводит.`
          : "Включить мониторинг можно после успешного Verify. Credentials обратно не показываются; пустое поле не стирает существующее."}
      </p>
      {initial.errorSafe && !msg && <p className="text-[11px] text-red-600">{initial.errorSafe}</p>}
    </div>
  );
}
