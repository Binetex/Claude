"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card, CardHeader, CardTitle, CardBody } from "@/components/ui/Card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ownerSaveEmailFactoryToken, ownerClearEmailFactoryToken, ownerProbeEmailFactory } from "./actions";
import type { EmailFactoryView } from "@/integrations/emailFactory/token";
import type { ProbeResult } from "@/integrations/emailFactory/probe";

/**
 * Токен Email Factory + разведка API. По образцу BrevoAccountPanel: значение хранится
 * зашифрованным, наружу — только маска.
 *
 * Блок «Что отвечает API» временный: он нужен, пока не решено, дорабатывать Email Factory или
 * там уже всё есть. Показывает коды ответов и ИМЕНА полей — не содержимое писем.
 */
export function EmailFactoryPanel({ view, defaultAddress }: { view: EmailFactoryView; defaultAddress: string }) {
  const router = useRouter();
  const [value, setValue] = useState("");
  const [address, setAddress] = useState(defaultAddress);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [results, setResults] = useState<ProbeResult[] | null>(null);
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
    run(async () => {
      const r = await ownerSaveEmailFactoryToken(value);
      if (r.ok) setValue("");
      return r;
    });
  }

  function probe() {
    setMsg(null);
    setResults(null);
    start(async () => {
      const r = await ownerProbeEmailFactory(address);
      if (r.error) setMsg({ ok: false, text: r.error });
      else setResults(r.results ?? []);
    });
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>Email Factory — токен</CardTitle>
          <span
            className={`rounded border px-1.5 py-px text-[10px] font-medium ${
              view.configured ? "border-emerald-200 bg-emerald-100 text-emerald-800" : "border-amber-200 bg-amber-100 text-amber-800"
            }`}
          >
            {view.configured ? "токен задан" : "токена нет"}
          </span>
        </CardHeader>
        <CardBody className="space-y-3 text-sm">
          <p className="text-xs text-slate-500">
            Токен аккаунта <span className="font-mono">mail.binetex.com</span>, хранится зашифрованным
            {view.maskedSuffix ? (
              <>
                : <span className="font-mono text-slate-700">{view.maskedSuffix}</span>
              </>
            ) : (
              "."
            )}{" "}
            Полное значение нигде не отображается и не логируется. Один токен на весь аккаунт — он и так видит все домены.
          </p>

          {!view.cryptoConfigured && (
            <div className="rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-700">
              Шифрование секретов не настроено на сервере (CREDENTIALS_ENCRYPTION_KEY) — сохранить токен не получится.
            </div>
          )}

          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-[280px] flex-1 space-y-1">
              <label className="text-xs text-slate-400">{view.configured ? "Новый токен (заменит текущий)" : "Токен"}</label>
              <Input
                value={value}
                onChange={(e) => {
                  setValue(e.target.value);
                  setMsg(null);
                }}
                type="password"
                autoComplete="new-password"
                placeholder="вставьте токен Email Factory"
              />
            </div>
            <Button type="button" size="sm" disabled={pending || !value.trim() || !view.cryptoConfigured} onClick={save}>
              Сохранить
            </Button>
            {view.configured && (
              <Button type="button" size="sm" variant="ghost" className="text-red-600" disabled={pending} onClick={() => run(ownerClearEmailFactoryToken)}>
                Удалить
              </Button>
            )}
          </div>

          {view.savedAt && <p className="text-[11px] text-slate-400">Сохранён {new Date(view.savedAt).toLocaleString("ru-RU")}.</p>}
          {msg && <div className={msg.ok ? "text-xs text-emerald-700" : "text-xs text-red-600"}>{msg.text}</div>}
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Что отвечает API</CardTitle>
        </CardHeader>
        <CardBody className="space-y-3 text-sm">
          <p className="text-xs text-slate-500">
            Разведка перед интеграцией: понимает ли API фильтр по адресу получателя и есть ли подписки на вебхуки. Делает только
            запросы на чтение — ни одного письма не отправляет и ничего не меняет. Показывает коды ответов и <b>названия</b> полей;
            содержимое писем сюда не попадает.
          </p>

          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-[260px] flex-1 space-y-1">
              <label className="text-xs text-slate-400">Адрес для проверки фильтра (можно оставить пустым)</label>
              <Input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="client@theflow.la" />
            </div>
            <Button type="button" size="sm" variant="outline" disabled={pending || !view.configured} onClick={probe}>
              Проверить
            </Button>
          </div>

          {results && results.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-slate-400">
                    <th className="py-1 pr-3 font-medium">Проверка</th>
                    <th className="py-1 pr-3 font-medium">Ответ</th>
                    <th className="py-1 font-medium">Поля</th>
                  </tr>
                </thead>
                <tbody>
                  {results.map((r) => (
                    <tr key={r.path} className="border-b border-slate-100 align-top">
                      <td className="py-1.5 pr-3">
                        <div className="text-slate-700">{r.label}</div>
                        <div className="font-mono text-[10px] text-slate-400">{r.path}</div>
                      </td>
                      <td className="py-1.5 pr-3">
                        {r.errorSafe ? (
                          <span className="text-red-600">{r.errorSafe}</span>
                        ) : (
                          <span className={r.status && r.status < 300 ? "text-emerald-700" : "text-amber-700"}>
                            {r.status}
                            {r.itemCount !== null && <span className="text-slate-400"> · {r.itemCount} шт.</span>}
                          </span>
                        )}
                      </td>
                      <td className="py-1.5 font-mono text-[10px] text-slate-500">
                        {r.topLevelKeys.length > 0 && <div>{r.topLevelKeys.join(", ")}</div>}
                        {r.itemKeys.length > 0 && <div className="text-slate-400">элемент: {r.itemKeys.join(", ")}</div>}
                        {r.topLevelKeys.length === 0 && r.itemKeys.length === 0 && <span className="text-slate-300">—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
