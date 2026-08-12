"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card, CardHeader, CardTitle, CardBody } from "@/components/ui/Card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ownerSaveEmailFactoryToken, ownerClearEmailFactoryToken } from "./actions";
import type { EmailFactoryView } from "@/integrations/emailFactory/token";

/**
 * Токен Email Factory. По образцу BrevoAccountPanel: значение хранится зашифрованным, наружу —
 * только маска.
 *
 * Разведка API (фильтры to=/direction=/since=, наличие вебхуков) проведена 2026-08-12 и её
 * результаты записаны в память проекта — временный блок с прогоном запросов, который для этого
 * стоял здесь, убран, свою задачу он выполнил.
 */
export function EmailFactoryPanel({ view }: { view: EmailFactoryView }) {
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
    run(async () => {
      const r = await ownerSaveEmailFactoryToken(value);
      if (r.ok) setValue("");
      return r;
    });
  }

  function clear() {
    // Кнопка стоит вплотную к «Сохранить», а промах отзывает подключение: вернуть его можно
    // только сходив за токеном в Email Factory заново. Тот же confirm, что в панели Brevo.
    if (!confirm("Удалить токен Email Factory? Чтобы подключить снова, понадобится взять токен в Email Factory.")) return;
    run(ownerClearEmailFactoryToken);
  }

  return (
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
            <Button type="button" size="sm" variant="ghost" className="text-red-600" disabled={pending} onClick={clear}>
              Удалить
            </Button>
          )}
        </div>

        {view.savedAt && <p className="text-[11px] text-slate-400">Сохранён {new Date(view.savedAt).toLocaleString("ru-RU")}.</p>}
        {msg && <div className={msg.ok ? "text-xs text-emerald-700" : "text-xs text-red-600"}>{msg.text}</div>}
      </CardBody>
    </Card>
  );
}
