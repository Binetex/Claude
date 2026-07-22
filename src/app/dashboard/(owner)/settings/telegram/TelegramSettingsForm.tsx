"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card, CardBody } from "@/components/ui/Card";
import { Button } from "@/components/ui/button";
import { saveSettings, removeToken, verifyConnection, toggleEnabled } from "./actions";
import type { TelegramSettingsView } from "@/integrations/telegram/settings";
import type { VerifyResult } from "@/integrations/telegram/verify";

const STEP_LABEL: Record<string, string> = {
  getMe: "Бот и токен",
  owner: "Сообщение владельцу",
  florists: "Сообщение флористам",
};

export function TelegramSettingsForm({ initial }: { initial: TelegramSettingsView }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  // Поле токена ВСЕГДА пустое: существующий токен наружу не отдаётся.
  const [botToken, setBotToken] = useState("");
  const [ownerChatId, setOwnerChatId] = useState(initial.ownerChatId);
  const [floristsChatId, setFloristsChatId] = useState(initial.floristsChatId);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [verify, setVerify] = useState<VerifyResult | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const verified = !!initial.verifiedAt;

  function run(fn: () => Promise<{ ok?: true; message?: string; error?: string }>) {
    setMsg(null);
    start(async () => {
      const r = await fn();
      setMsg(r.error ? { ok: false, text: r.error } : { ok: true, text: r.message ?? "Готово" });
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      {!initial.cryptoConfigured && (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          На сервере не задан ключ шифрования credentials — сохранить токен не получится.
          Это та же настройка, что используется для Shopify, QUO и Burq.
        </div>
      )}

      <Card>
        <CardBody className="space-y-4">
          <label className="block space-y-1">
            <span className="text-xs text-slate-500">Bot Token</span>
            <input
              type="password"
              autoComplete="new-password"
              value={botToken}
              onChange={(e) => setBotToken(e.target.value)}
              placeholder={initial.botTokenConfigured ? "Настроен — оставьте пустым, чтобы не менять" : "123456:AA..."}
              className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
            />
            <span className="flex items-center gap-2 text-[11px]">
              {initial.botTokenConfigured ? (
                <span className="rounded border border-emerald-200 bg-emerald-50 px-1.5 py-px text-emerald-700">Configured</span>
              ) : (
                <span className="rounded border border-slate-200 bg-slate-50 px-1.5 py-px text-slate-500">Не задан</span>
              )}
              <span className="text-slate-400">Токен не показывается обратно. Пустое поле не стирает существующий.</span>
            </span>
          </label>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="space-y-1">
              <span className="text-xs text-slate-500">Owner Chat ID</span>
              <input value={ownerChatId} onChange={(e) => setOwnerChatId(e.target.value)} placeholder="-1001234567890" className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm" />
            </label>
            <label className="space-y-1">
              <span className="text-xs text-slate-500">Florists Chat ID</span>
              <input value={floristsChatId} onChange={(e) => setFloristsChatId(e.target.value)} placeholder="-1009876543210" className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm" />
            </label>
          </div>
          <p className="text-[11px] text-slate-400">
            У групп Chat ID отрицательный. Добавьте бота в оба чата, иначе проверка не пройдёт.
          </p>

          <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3">
            <Button size="sm" disabled={pending} onClick={() => run(() => saveSettings({ botToken, ownerChatId, floristsChatId }))}>
              Сохранить
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() => {
                setMsg(null);
                setVerify(null);
                start(async () => {
                  const r = await verifyConnection();
                  if ("error" in r) setMsg({ ok: false, text: r.error });
                  else {
                    setVerify(r.result);
                    setMsg({ ok: r.result.ok, text: r.result.ok ? "Проверка пройдена — можно включать." : "Проверка не пройдена." });
                  }
                  router.refresh();
                });
              }}
            >
              Проверить подключение
            </Button>
            {initial.botTokenConfigured && (
              confirmDelete ? (
                <>
                  <Button size="sm" variant="destructive" disabled={pending} onClick={() => { setConfirmDelete(false); run(removeToken); }}>
                    Точно удалить токен?
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>Отмена</Button>
                </>
              ) : (
                <Button size="sm" variant="ghost" disabled={pending} onClick={() => setConfirmDelete(true)}>Удалить токен</Button>
              )
            )}
            {msg && <span className={msg.ok ? "text-xs text-emerald-700" : "text-xs text-red-600"}>{msg.text}</span>}
          </div>
        </CardBody>
      </Card>

      {(verify || initial.lastErrorSafe) && (
        <Card>
          <CardBody className="space-y-1.5">
            <h2 className="text-sm font-semibold text-slate-800">Результат проверки</h2>
            {verify?.steps.map((s) => (
              <div key={s.step} className="flex items-start gap-2 text-xs">
                <span className={s.ok ? "text-emerald-600" : "text-red-600"}>{s.ok ? "✓" : "✕"}</span>
                <span className="text-slate-600"><b>{STEP_LABEL[s.step] ?? s.step}:</b> {s.detail}</span>
              </div>
            ))}
            {!verify && initial.lastErrorSafe && <p className="text-xs text-red-600">{initial.lastErrorSafe}</p>}
          </CardBody>
        </Card>
      )}

      <Card>
        <CardBody className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-sm font-semibold text-slate-800">Уведомления</h2>
              <p className="text-xs text-slate-500">
                {verified
                  ? `Проверено ${new Date(initial.verifiedAt!).toLocaleString("ru-RU")}${initial.botUsername ? ` · @${initial.botUsername}` : ""}`
                  : "Включение доступно после успешной проверки подключения."}
              </p>
            </div>
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                className="h-4 w-4"
                checked={initial.enabled}
                disabled={pending || (!verified && !initial.enabled)}
                onChange={(e) => run(() => toggleEnabled(e.target.checked))}
              />
              {initial.enabled ? "Включены" : "Выключены"}
            </label>
          </div>
          {initial.enabled && (
            <p className="text-[11px] text-slate-400">
              Изменение токена или Chat ID сбросит проверку и выключит уведомления — это защита от включённой,
              но заведомо нерабочей конфигурации.
            </p>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
