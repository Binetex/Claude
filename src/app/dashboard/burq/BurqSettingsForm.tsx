"use client";
import { useActionState, useState, useTransition } from "react";
import { Card, CardHeader, CardTitle, CardBody } from "@/components/ui/Card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { saveBurqSettingsAction, checkBurqConnectionAction, toggleBurqDraftCreationAction } from "./burqActions";
import type { BurqSettingsView } from "@/integrations/delivery/burq/settings";

const CONNECTION_LABEL: Record<string, string> = {
  ok: "Подключение подтверждено",
  unauthorized: "Ключ отклонён (unauthorized)",
  error: "Ошибка проверки",
  saved_not_checked: "Сохранено, не проверено",
  no_key: "Ключ не задан",
};

export function BurqSettingsForm({ settings, webhookUrl }: { settings: BurqSettingsView; webhookUrl: string }) {
  const [saveState, saveAction, saving] = useActionState(saveBurqSettingsAction, null);
  const [env, setEnv] = useState<"SANDBOX" | "PRODUCTION">(settings.environment);
  const [prodConfirmed, setProdConfirmed] = useState(false);
  const [checkState, setCheckState] = useState<{ ok?: boolean; error?: string; message?: string } | null>(null);
  const [checking, startCheck] = useTransition();
  const [toggling, startToggle] = useTransition();
  const [draftOn, setDraftOn] = useState(settings.draftCreationEnabled);

  const prodBlocked = env === "PRODUCTION" && !prodConfirmed;

  return (
    <div className="space-y-4">
      {!settings.cryptoConfigured && (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          Шифрование credentials не настроено на сервере (CREDENTIALS_ENCRYPTION_KEY). Сохранение ключей недоступно.
        </div>
      )}

      {/* ── Настройки и credentials ── */}
      <Card>
        <CardHeader>
          <CardTitle>Настройки Burq</CardTitle>
        </CardHeader>
        <CardBody>
          <form action={saveAction} className="space-y-4">
            {/* Environment */}
            <div className="space-y-1">
              <Label className="text-xs">Окружение</Label>
              <div className="flex gap-4 text-sm">
                <label className="flex items-center gap-2">
                  <input type="radio" name="environment" value="SANDBOX" checked={env === "SANDBOX"} onChange={() => setEnv("SANDBOX")} /> Sandbox
                </label>
                <label className="flex items-center gap-2">
                  <input type="radio" name="environment" value="PRODUCTION" checked={env === "PRODUCTION"} onChange={() => setEnv("PRODUCTION")} /> Production
                </label>
              </div>
              {env === "SANDBOX" ? (
                <p className="rounded bg-amber-50 px-2 py-1 text-xs text-amber-700">
                  Тестовый режим. Реальные курьеры и списания не должны запускаться.
                </p>
              ) : (
                <p className="rounded bg-red-50 px-2 py-1 text-xs text-red-700">
                  Боевой режим. Не включайте до завершения sandbox-проверки.
                </p>
              )}
              {env === "PRODUCTION" && (
                <label className="flex items-center gap-2 text-xs text-red-700">
                  <input type="checkbox" checked={prodConfirmed} onChange={(e) => setProdConfirmed(e.target.checked)} />
                  Подтверждаю переключение на боевой режим Burq.
                </label>
              )}
            </div>

            {/* API Key */}
            <div className="space-y-1">
              <Label className="text-xs">API Key {settings.hasApiKey && <span className="text-slate-400">(сохранён: {settings.apiKeyMask})</span>}</Label>
              <Input name="apiKey" type="password" autoComplete="off" placeholder={settings.hasApiKey ? "Оставьте пустым, чтобы не менять" : "Вставьте API Key"} />
            </div>

            {/* Webhook Signing Secret */}
            <div className="space-y-1">
              <Label className="text-xs">
                Webhook Signing Secret {settings.hasWebhookSecret && <span className="text-slate-400">(сохранён: {settings.webhookSecretMask})</span>}
              </Label>
              <Input name="webhookSecret" type="password" autoComplete="off" placeholder={settings.hasWebhookSecret ? "Оставьте пустым, чтобы не менять" : "Вставьте Signing Secret"} />
            </div>

            {/* Advanced: base URL (read-only default) */}
            <details className="rounded border border-slate-200 bg-slate-50 p-2">
              <summary className="cursor-pointer text-xs font-medium text-slate-600">Дополнительно: API Base URL</summary>
              <div className="mt-2 space-y-1">
                <Input name="apiBaseUrl" defaultValue={settings.apiBaseUrl} autoComplete="off" />
                <p className="text-[11px] text-slate-400">По умолчанию официальный URL. Sandbox и Production используют один host — режим задаёт тестовый/боевой ключ.</p>
              </div>
            </details>

            {/* Order-level dimensions (обязательны в Create Order V2) */}
            <details className="rounded border border-slate-200 bg-slate-50 p-2">
              <summary className="cursor-pointer text-xs font-medium text-slate-600">Размеры посылки (обязательны для Burq)</summary>
              <div className="mt-2 space-y-2">
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <div className="space-y-1"><Label className="text-xs">Длина</Label><Input name="dimLength" type="number" step="0.1" min="0" defaultValue={settings.dimensions.length} /></div>
                  <div className="space-y-1"><Label className="text-xs">Ширина</Label><Input name="dimWidth" type="number" step="0.1" min="0" defaultValue={settings.dimensions.width} /></div>
                  <div className="space-y-1"><Label className="text-xs">Высота</Label><Input name="dimHeight" type="number" step="0.1" min="0" defaultValue={settings.dimensions.height} /></div>
                  <div className="space-y-1"><Label className="text-xs">Вес</Label><Input name="dimWeight" type="number" step="0.1" min="0" defaultValue={settings.dimensions.weight} /></div>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1">
                    <Label className="text-xs">Ед. размера</Label>
                    <select name="dimensionUnit" defaultValue={settings.dimensions.dimensionUnit} className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm">
                      <option value="in">in (дюймы)</option>
                      <option value="cm">cm</option>
                    </select>
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Ед. веса</Label>
                    <select name="weightUnit" defaultValue={settings.dimensions.weightUnit} className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm">
                      <option value="lb">lb</option>
                      <option value="kg">kg</option>
                      <option value="g">g</option>
                    </select>
                  </div>
                </div>
                <p className="text-[11px] text-slate-400">Типовой букет по умолчанию. Значения глобальные (не per-order).</p>
              </div>
            </details>

            {/* Burq enabled */}
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input type="checkbox" name="enabled" value="1" defaultChecked={settings.enabled} /> Burq enabled (интеграция активна)
            </label>

            <div className="flex items-center gap-2">
              <Button type="submit" size="sm" disabled={saving || prodBlocked || !settings.cryptoConfigured}>
                {saving ? "Сохранение…" : "Сохранить"}
              </Button>
              {prodBlocked && <span className="text-xs text-red-600">Подтвердите боевой режим, чтобы сохранить.</span>}
            </div>
            {saveState?.error && <p className="text-xs text-red-600">{saveState.error}</p>}
            {saveState?.ok && <p className="text-xs text-emerald-700">{saveState.message}</p>}
          </form>
        </CardBody>
      </Card>

      {/* ── Проверка подключения ── */}
      <Card>
        <CardHeader>
          <CardTitle>Проверка подключения</CardTitle>
        </CardHeader>
        <CardBody className="space-y-2 text-sm">
          <div className="text-slate-600">
            Статус: <span className="font-medium">{CONNECTION_LABEL[settings.connectionStatus ?? ""] ?? "не проверялось"}</span>
            {settings.lastConnectionCheckAt && <span className="ml-2 text-xs text-slate-400">({new Date(settings.lastConnectionCheckAt).toLocaleString()})</span>}
          </div>
          {settings.connectionErrorSafe && <div className="text-xs text-amber-700">{settings.connectionErrorSafe}</div>}
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={checking || !settings.hasApiKey}
            onClick={() =>
              startCheck(async () => {
                setCheckState(null);
                const r = await checkBurqConnectionAction();
                setCheckState(r);
              })
            }
          >
            {checking ? "Проверка…" : "Проверить подключение"}
          </Button>
          <p className="text-[11px] text-slate-400">Безопасный read-only запрос (GET), заказы не создаются.</p>
          {checkState?.error && <p className="text-xs text-red-600">{checkState.error}</p>}
          {checkState?.ok && <p className="text-xs text-emerald-700">{checkState.message}</p>}
        </CardBody>
      </Card>

      {/* ── Webhook ── */}
      <Card>
        <CardHeader>
          <CardTitle>Webhook</CardTitle>
        </CardHeader>
        <CardBody className="space-y-2 text-sm">
          <Label className="text-xs">Endpoint (read-only)</Label>
          <Input readOnly value={webhookUrl} onFocus={(e) => e.currentTarget.select()} className="font-mono text-xs" />
          <ol className="ml-4 list-decimal space-y-0.5 text-xs text-slate-600">
            <li>Откройте Burq Dashboard.</li>
            <li>Добавьте webhook endpoint (URL выше).</li>
            <li>Выберите событие delivery.updated и другие подтверждённые события.</li>
            <li>Скопируйте Signing Secret.</li>
            <li>Вставьте его во Floremart (поле выше) и сохраните.</li>
          </ol>
          <p className="text-[11px] text-slate-400">Регистрация webhook выполняется в Burq Dashboard (не через API).</p>
        </CardBody>
      </Card>

      {/* ── Авто-создание draft (отдельный гейт) ── */}
      <Card>
        <CardHeader>
          <CardTitle>Авто-создание доставок</CardTitle>
        </CardHeader>
        <CardBody className="space-y-2 text-sm">
          <p className="text-slate-600">
            Отдельный гейт. Держите ВЫКЛ до завершения sandbox smoke-теста — при выключенном флаге реальные Burq-доставки не создаются.
          </p>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={draftOn}
              disabled={toggling}
              onChange={(e) => {
                const next = e.target.checked;
                setDraftOn(next);
                startToggle(async () => {
                  const r = await toggleBurqDraftCreationAction(next);
                  if (r?.error) setDraftOn(!next);
                });
              }}
            />
            Авто-создание Burq draft включено
          </label>
        </CardBody>
      </Card>

      {/* ── Тестовый draft (пока недоступен) ── */}
      <Card>
        <CardHeader>
          <CardTitle>Тестовый draft (Sandbox)</CardTitle>
        </CardHeader>
        <CardBody className="space-y-2 text-sm">
          <Button type="button" size="sm" variant="outline" disabled title="Доступно после проверки ключа">
            Создать тестовый draft в Sandbox
          </Button>
          <p className="text-[11px] text-slate-400">Доступно после проверки ключа. Использует только синтетические данные, создаёт ровно один draft, затем предложит удалить его.</p>
        </CardBody>
      </Card>
    </div>
  );
}
