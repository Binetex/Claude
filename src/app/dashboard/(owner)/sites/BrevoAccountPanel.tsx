"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card, CardHeader, CardTitle, CardBody } from "@/components/ui/Card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ownerSaveBrevoApiKey, ownerClearBrevoApiKey, ownerVerifyBrevoConnection } from "./emailActions";
import type { BrevoAccountView } from "@/integrations/email/accountKey";

/**
 * Глобальный блок «Brevo API key» (workspace-level, один аккаунт на все магазины, не per-Site).
 * По образцу SiteQuoWebhookSecurity/AirwallexMonitoringPanel: значение хранится зашифрованным,
 * наружу — только маска; «Проверить подключение» подтверждает реальную работоспособность ключа
 * без отправки писем.
 */
export function BrevoAccountPanel({ view }: { view: BrevoAccountView }) {
  const router = useRouter();
  const [value, setValue] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();

  function run(fn: () => Promise<{ ok?: true; message?: string; error?: string }>) {
    setMsg(null);
    start(async () => {
      const r = await fn();
      setMsg(r.error ? { ok: false, text: r.error } : { ok: true, text: r.message ?? "Готово" });
      router.refresh();
    });
  }

  function save() {
    const fd = new FormData();
    fd.set("apiKey", value);
    run(async () => {
      const r = await ownerSaveBrevoApiKey(null, fd);
      if (r.ok) setValue("");
      return r;
    });
  }

  function clear() {
    if (!confirm("Удалить сохранённый ключ из БД? Отправка станет недоступна, если нет env BREVO_API_KEY.")) return;
    run(ownerClearBrevoApiKey);
  }

  return (
    <Card>
      <CardHeader className="flex flex-wrap items-center justify-between gap-2">
        <CardTitle>Brevo API key</CardTitle>
        <div className="flex items-center gap-1.5">
          <span className={`rounded border px-1.5 py-px text-[10px] font-medium ${view.configured ? "bg-emerald-100 text-emerald-800 border-emerald-200" : "bg-amber-100 text-amber-800 border-amber-200"}`}>
            {view.configured ? `настроен · ${view.source === "db" ? "БД" : "env"}` : "не настроен"}
          </span>
          {view.connStatus === "CONNECTED" && (
            <span className="rounded border border-sky-200 bg-sky-50 px-1.5 py-px text-[10px] text-sky-700">Проверено</span>
          )}
        </div>
      </CardHeader>
      <CardBody className="space-y-3 text-sm">
        <p className="text-xs text-slate-500">
          Общий Brevo-аккаунт на все магазины (workspace-level, не per-Site). Ключ хранится зашифрованным в БД
          {view.maskedSuffix ? <>: <span className="font-mono text-slate-700">{view.maskedSuffix}</span></> : "."} Полное значение
          нигде не отображается и не логируется.
        </p>

        {!view.cryptoConfigured && (
          <div className="rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-700">
            Шифрование секретов не настроено на сервере (CREDENTIALS_ENCRYPTION_KEY) — сохранить ключ через UI не получится.
          </div>
        )}

        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-[280px] flex-1 space-y-1">
            <label className="text-xs text-slate-400">{view.source === "db" ? "Новый API key (заменит текущий)" : "Brevo API key"}</label>
            <Input value={value} onChange={(e) => { setValue(e.target.value); setMsg(null); }} type="password" autoComplete="new-password" placeholder="xkeysib-…" />
          </div>
          <Button type="button" size="sm" disabled={pending || !value.trim() || !view.cryptoConfigured} onClick={save}>Сохранить</Button>
          <Button type="button" size="sm" variant="outline" disabled={pending || !view.configured} onClick={() => run(ownerVerifyBrevoConnection)}>
            Проверить подключение
          </Button>
          {view.source === "db" && (
            <Button type="button" size="sm" variant="ghost" className="text-red-600" disabled={pending} onClick={clear}>Удалить ключ</Button>
          )}
        </div>

        {msg && <div className={msg.ok ? "text-xs text-emerald-700" : "text-xs text-red-600"}>{msg.text}</div>}

        {view.connStatus && (
          <p className={view.connStatus === "CONNECTED" ? "text-[11px] text-slate-400" : "text-[11px] text-red-600"}>
            {view.connStatus === "CONNECTED"
              ? `Последняя проверка ${view.verifiedAt ? new Date(view.verifiedAt).toLocaleString("ru-RU") : ""} — успешно${view.accountEmail ? ` (аккаунт: ${view.accountEmail})` : ""}.`
              : `Последняя проверка: ${view.errorSafe ?? "ошибка"}.`}
          </p>
        )}
      </CardBody>
    </Card>
  );
}
