"use client";
import { useActionState, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardBody } from "@/components/ui/Card";
import { Cpu } from "lucide-react";
import { ownerSaveAiModel, ownerClearAiKey, ownerCheckAiModel } from "./actions";
import type { ModelBalance } from "@/integrations/deepseek/balance";

export type AiModelFormState = {
  apiKeyMask: string | null;
  baseUrl: string | null;
  model: string | null;
  checkStatus: string | null;
  checkAt: string | null;
  checkErrorSafe: string | null;
  usingEnvKey: boolean;
  effectiveBaseUrl: string | null;
  effectiveModel: string | null;
};

/**
 * Готовые связки «адрес API + модель». Замеры на настоящей переписке (сентябрь 2026) — чтобы
 * выбор делался по делу, а не по названию.
 */
const PRESETS = [
  {
    id: "deepseek-chat",
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-chat",
    label: "DeepSeek · deepseek-chat",
    note: "Дёшево и быстро (~1 с), но в замере переспрашивала то, на что клиент уже ответил.",
  },
  {
    id: "deepseek-reasoner",
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-reasoner",
    label: "DeepSeek · deepseek-reasoner",
    note: "Самый точный по смыслу: единственный, кто сверил окно доставки и сказал, что «после 4» не выйдет. Медленный — 12–30 с.",
  },
  {
    id: "gpt-4.1-mini",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4.1-mini",
    label: "OpenAI · gpt-4.1-mini",
    note: "Хороший ответ за ~2 с, стабильно. Нужен ключ OpenAI (sk-…).",
  },
  {
    id: "gpt-5.1",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-5.1",
    label: "OpenAI · gpt-5.1",
    note: "Быстрый и толковый, но в замере пообещал время вне окна доставки. Нужен ключ OpenAI.",
  },
];

function statusMeta(s: AiModelFormState): { label: string; cls: string } {
  if (s.checkStatus === "ok") return { label: "Проверено", cls: "bg-emerald-100 text-emerald-800 border-emerald-200" };
  if (s.checkStatus === "error") return { label: "Ошибка проверки", cls: "bg-red-100 text-red-800 border-red-200" };
  if (s.checkStatus === "saved_not_checked") return { label: "Сохранено, не проверено", cls: "bg-amber-100 text-amber-800 border-amber-200" };
  return { label: "Не проверялось", cls: "bg-slate-100 text-slate-600 border-slate-200" };
}

/** Ниже этой суммы предупреждаем красным: рассуждающая модель съедает её за считаные ответы. */
const LOW_BALANCE_USD = 5;

function BalanceRow({ balance }: { balance: ModelBalance | null }) {
  if (!balance) return null;
  if (!balance.supported) return <p className="text-[11px] text-slate-400">Остаток: {balance.reason}</p>;

  const num = Number(balance.total);
  const low = Number.isFinite(num) && num < LOW_BALANCE_USD;
  return (
    <div
      className={`rounded-lg border px-3 py-2 text-xs ${
        low ? "border-red-200 bg-red-50 text-red-700" : "border-emerald-200 bg-emerald-50 text-emerald-800"
      }`}
    >
      Остаток на аккаунте модели: <span className="font-semibold tabular-nums">{balance.total} {balance.currency}</span>
      {!balance.available && " · провайдер отметил аккаунт как недоступный"}
      {low && " — на нуле ассистент замолчит. Рассуждающая модель тратит по несколько тысяч токенов на ответ, этого хватит ненадолго."}
    </div>
  );
}

export function AiModelForm({ current, balance }: { current: AiModelFormState; balance: ModelBalance | null }) {
  const [state, action, saving] = useActionState(ownerSaveAiModel, null);
  const [baseUrl, setBaseUrl] = useState(current.baseUrl ?? "https://api.deepseek.com");
  const [model, setModel] = useState(current.model ?? current.effectiveModel ?? "deepseek-chat");
  const [apiKey, setApiKey] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();

  const st = statusMeta(current);
  const activePreset = PRESETS.find((p) => p.model === model && p.baseUrl === baseUrl);

  function run(fn: () => Promise<{ ok?: true; message?: string; error?: string }>) {
    setMsg(null);
    start(async () => {
      const r = await fn();
      setMsg(r.error ? { ok: false, text: r.error } : { ok: true, text: r.message ?? "Готово" });
    });
  }

  return (
    <Card>
      <CardHeader className="py-2.5"><CardTitle icon={Cpu}>Модель ассистента</CardTitle></CardHeader>
      <CardBody className="space-y-4">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className={`rounded border px-1.5 py-px font-medium ${st.cls}`}>{st.label}</span>
          <span className="text-slate-500">
            Сейчас работает: <span className="font-medium text-slate-800">{current.effectiveModel ?? "не задана"}</span>
            {current.effectiveBaseUrl ? ` · ${current.effectiveBaseUrl}` : ""}
          </span>
          {current.checkAt && <span className="text-slate-400">проверка {new Date(current.checkAt).toLocaleString("ru-RU")}</span>}
        </div>

        {current.checkErrorSafe && <p className="text-xs text-red-600">⚠ {current.checkErrorSafe}</p>}

        <BalanceRow balance={balance} />

        {current.usingEnvKey && (
          <p className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
            Ключ сейчас берётся из настроек сервера. Введите свой ниже — он ляжет в базу в зашифрованном
            виде и станет главнее серверного.
          </p>
        )}

        {/* Готовые варианты: один клик подставляет адрес и модель */}
        <div className="space-y-1.5">
          <div className="text-xs font-semibold text-slate-500">Готовые варианты</div>
          <div className="grid gap-1.5 sm:grid-cols-2">
            {PRESETS.map((p) => {
              const active = activePreset?.id === p.id;
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => { setBaseUrl(p.baseUrl); setModel(p.model); }}
                  className={`rounded-lg border px-3 py-2 text-left transition-colors ${
                    active ? "border-slate-800 bg-slate-50" : "border-slate-200 bg-white hover:bg-slate-50"
                  }`}
                >
                  <div className="text-sm font-medium text-slate-800">{p.label}</div>
                  <div className="mt-0.5 text-[11px] leading-snug text-slate-500">{p.note}</div>
                </button>
              );
            })}
          </div>
        </div>

        <form action={action} className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1 text-xs">
              <span className="text-slate-500">Адрес API</span>
              <input
                name="baseUrl"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="https://api.deepseek.com"
                className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
              />
            </label>
            <label className="space-y-1 text-xs">
              <span className="text-slate-500">Модель</span>
              <input
                name="model"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="deepseek-chat"
                className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
              />
            </label>
          </div>

          <label className="space-y-1 text-xs">
            <span className="text-slate-500">
              Ключ доступа{current.apiKeyMask ? ` — сейчас ${current.apiKeyMask}` : ""}
            </span>
            <input
              name="apiKey"
              type="password"
              autoComplete="off"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={current.apiKeyMask ? "оставьте пустым — ключ не изменится" : "sk-… или ключ DeepSeek"}
              className="w-full rounded-md border border-slate-300 px-2 py-1.5 font-mono text-sm"
            />
            <span className="block text-[11px] text-slate-400">
              Хранится зашифрованным. Обратно не показывается — только последние символы.
              У DeepSeek и OpenAI ключи РАЗНЫЕ: меняя адрес API, введите ключ того же сервиса.
            </span>
          </label>

          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" size="sm" disabled={saving || pending}>{saving ? "Сохраняем…" : "Сохранить"}</Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={saving || pending}
              onClick={() => run(() => ownerCheckAiModel({ baseUrl, model, apiKey }))}
            >
              Проверить
            </Button>
            {current.apiKeyMask && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={saving || pending}
                onClick={() => { if (confirm("Убрать ключ из базы? Ассистент вернётся к ключу с сервера или замолчит.")) run(ownerClearAiKey); }}
              >
                Убрать ключ
              </Button>
            )}
          </div>
        </form>

        {state?.error && <div className="text-xs text-red-600">{state.error}</div>}
        {state?.ok && <div className="text-xs text-emerald-700">{state.message}</div>}
        {msg && <div className={msg.ok ? "text-xs text-emerald-700" : "text-xs text-red-600"}>{msg.text}</div>}
      </CardBody>
    </Card>
  );
}
