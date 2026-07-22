"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card, CardHeader, CardTitle, CardBody } from "@/components/ui/Card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ownerAddQuoSigningSecret, ownerRemoveQuoSigningSecret, ownerCheckQuoSigningConfig, type QuoSigningConfig } from "./quoWebhookActions";

type Item = { id: string; maskedSuffix: string; createdAt: string };

/**
 * Глобальный блок «QUO Webhook Security» (workspace-level, не per-Site, owner-only).
 * Позволяет добавлять/удалять QUO webhook signing secrets без SSH. Наружу — только маски.
 */
export function SiteQuoWebhookSecurity({ secrets, envCount, cryptoConfigured }: { secrets: Item[]; envCount: number; cryptoConfigured: boolean }) {
  const router = useRouter();
  const [value, setValue] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [check, setCheck] = useState<QuoSigningConfig | null>(null);
  const [pending, start] = useTransition();

  const totalActive = envCount + secrets.length;
  const configured = totalActive > 0;

  function add() {
    setMsg(null);
    start(async () => {
      const r = await ownerAddQuoSigningSecret(value);
      if (r.error) { setMsg({ ok: false, text: r.error }); return; }
      setValue("");
      setMsg({ ok: true, text: "Secret добавлен — сохранена только маска, он уже используется." });
      router.refresh();
    });
  }

  function remove(item: Item) {
    const last = secrets.length === 1 && envCount === 0;
    const warn = last
      ? "Это ПОСЛЕДНИЙ активный signing secret, и env-ключей нет. После удаления приём вебхуков QUO перестанет проходить проверку подписи. Точно удалить?"
      : "Удалить этот signing secret? Он перестанет приниматься.";
    if (!confirm(warn)) return;
    setMsg(null);
    start(async () => {
      const r = await ownerRemoveQuoSigningSecret(item.id);
      if (r.error) { setMsg({ ok: false, text: r.error }); return; }
      setMsg({ ok: true, text: "Secret удалён." });
      router.refresh();
    });
  }

  function doCheck() {
    setMsg(null);
    start(async () => setCheck(await ownerCheckQuoSigningConfig()));
  }

  return (
    <Card>
      <CardHeader className="flex flex-wrap items-center justify-between gap-2">
        <CardTitle>QUO Webhook Security</CardTitle>
        <span className={`rounded border px-1.5 py-px text-[10px] font-medium ${configured ? "bg-emerald-100 text-emerald-800 border-emerald-200" : "bg-amber-100 text-amber-800 border-amber-200"}`}>
          {configured ? "настроено" : "не настроено"}
        </span>
      </CardHeader>
      <CardBody className="space-y-3 text-sm">
        <p className="text-xs text-slate-500">
          Глобальная настройка workspace (не per-Site). Signing secret из QUO/OpenPhone для проверки подписи входящих вебхуков.
          Активных ключей: <b>{totalActive}</b> (env: {envCount}, из UI: {secrets.length}). Полное значение не показывается.
        </p>

        {!cryptoConfigured && (
          <div className="rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-700">
            Шифрование секретов не настроено на сервере (CREDENTIALS_ENCRYPTION_KEY) — добавление недоступно.
          </div>
        )}

        {/* Список активных секретов из UI (маски) */}
        {secrets.length > 0 && (
          <ul className="divide-y divide-slate-100 rounded-md border border-slate-200">
            {secrets.map((s) => (
              <li key={s.id} className="flex items-center justify-between gap-2 px-3 py-2">
                <span className="font-mono text-slate-700">{s.maskedSuffix}</span>
                <span className="ml-auto text-[11px] text-slate-400">{new Date(s.createdAt).toLocaleString("ru-RU")}</span>
                <Button type="button" size="sm" variant="ghost" className="text-red-600" disabled={pending} onClick={() => remove(s)}>Удалить</Button>
              </li>
            ))}
          </ul>
        )}
        {secrets.length === 0 && envCount > 0 && (
          <div className="text-xs text-slate-400">Ключи заданы только через env ({envCount}). Можно добавить дополнительные через UI.</div>
        )}

        {/* Добавление */}
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-[260px] flex-1 space-y-1">
            <label className="text-xs text-slate-400">New webhook signing secret</label>
            <Input value={value} onChange={(e) => { setValue(e.target.value); setMsg(null); }} type="password" autoComplete="off" placeholder="вставьте signing secret из QUO" />
          </div>
          <Button type="button" size="sm" disabled={pending || !value.trim() || !cryptoConfigured} onClick={add}>Добавить</Button>
          <Button type="button" size="sm" variant="outline" disabled={pending} onClick={doCheck}>Проверить конфигурацию</Button>
        </div>

        {msg && <div className={msg.ok ? "text-xs text-emerald-700" : "text-xs text-red-600"}>{msg.text}</div>}
        {check && (
          <div className="rounded-md border border-slate-200 bg-slate-50 p-2 text-xs text-slate-600">
            Шифрование: {check.cryptoConfigured ? "ок" : "не настроено"} · env-ключей: {check.envCount} · из UI: {check.dbCount} · всего активных: {check.totalActive} · расшифровка: {check.decryptOk ? "ок" : "ошибка"}.
            <div className="mt-0.5 text-slate-400">Фактический приём подтвердится на следующем вебхуке (webhook.accepted в логах).</div>
          </div>
        )}
      </CardBody>
    </Card>
  );
}
