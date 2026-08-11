"use client";
/**
 * Email-настройки магазина. Строится по образцу AirwallexMonitoringPanel: сохранить → проверить
 * тестом → только потом включить.
 *
 * Чекбокс «включить» намеренно заблокирован, пока не сохранены отправитель и отметка о
 * подтверждённом домене: сервер это тоже проверяет, но кнопка не должна обещать невозможное.
 */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { listSmsTriggers } from "@/modules/automations/triggers";
import type { SiteEmailSettingsView } from "@/integrations/email/settings";
import {
  ownerSaveSiteEmail,
  ownerToggleSiteEmail,
  ownerSaveSiteEmailTemplate,
  ownerSendSiteTestEmail,
} from "./emailActions";

const input = "rounded-md border border-slate-300 px-2 py-1.5 text-sm";

export function SiteEmailPanel({ siteId, initial }: { siteId: string; initial: SiteEmailSettingsView }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [senderEmail, setSenderEmail] = useState(initial.senderEmail ?? "");
  const [senderName, setSenderName] = useState(initial.senderName ?? "");
  const [replyTo, setReplyTo] = useState(initial.replyTo ?? "");
  const [brevoSenderId, setBrevoSenderId] = useState(initial.brevoSenderId ?? "");
  const [domainVerified, setDomainVerified] = useState(initial.domainVerified);
  const [testTo, setTestTo] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // Включать можно только то, что уже сохранено — черновик в полях сервер не увидит.
  const canEnable = !!initial.senderEmail && initial.domainVerified;
  const triggers = listSmsTriggers();

  function run(fn: () => Promise<{ ok?: true; message?: string; error?: string }>) {
    setMsg(null);
    start(async () => {
      const r = await fn();
      setMsg(r.error ? { ok: false, text: r.error } : { ok: true, text: r.message ?? "Готово" });
      router.refresh();
    });
  }

  return (
    <div className="space-y-2 rounded-md border border-slate-200 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold text-slate-600">Email (Brevo)</span>
        {initial.enabled ? (
          <span className="rounded border border-emerald-200 bg-emerald-50 px-1.5 py-px text-[11px] text-emerald-700">Включён</span>
        ) : (
          <span className="rounded border border-slate-200 bg-slate-50 px-1.5 py-px text-[11px] text-slate-500">Выключен</span>
        )}
        {initial.domainVerified && (
          <span className="rounded border border-sky-200 bg-sky-50 px-1.5 py-px text-[11px] text-sky-700">Домен подтверждён</span>
        )}
        {initial.lastTestStatus === "ok" && (
          <span className="rounded border border-emerald-200 bg-emerald-50 px-1.5 py-px text-[11px] text-emerald-700">Тест пройден</span>
        )}
      </div>

      {!initial.brevoApiKeyConfigured && (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-2 text-[11px] text-amber-800">
          У этого магазина не задан Brevo API key — настройки сохранить можно, отправка (включая тест) недоступна.
          Ключ вставляется в блоке «Brevo API key» выше.
        </div>
      )}

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-xs text-slate-500">
          Sender email
          <input value={senderEmail} onChange={(e) => setSenderEmail(e.target.value)} placeholder="orders@example.com" className={input} />
        </label>
        <label className="flex flex-col gap-1 text-xs text-slate-500">
          Sender name
          <input value={senderName} onChange={(e) => setSenderName(e.target.value)} placeholder="Название магазина" className={input} />
        </label>
        <label className="flex flex-col gap-1 text-xs text-slate-500">
          Reply-To (необязательно)
          <input value={replyTo} onChange={(e) => setReplyTo(e.target.value)} placeholder="help@example.com" className={input} />
        </label>
        <label className="flex flex-col gap-1 text-xs text-slate-500">
          Brevo sender ID (необязательно)
          <input value={brevoSenderId} onChange={(e) => setBrevoSenderId(e.target.value)} placeholder="напр. 12" className={input} />
        </label>
      </div>

      <label className="flex items-center gap-1.5 text-xs text-slate-600">
        <input type="checkbox" className="h-4 w-4" checked={domainVerified} onChange={(e) => setDomainVerified(e.target.checked)} />
        домен отправителя подтверждён в Brevo (DKIM/SPF)
      </label>

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={pending} onClick={() => run(() => {
          const fd = new FormData();
          fd.set("siteId", siteId);
          fd.set("senderEmail", senderEmail);
          fd.set("senderName", senderName);
          fd.set("replyTo", replyTo);
          fd.set("brevoSenderId", brevoSenderId);
          fd.set("domainVerified", domainVerified ? "1" : "0");
          return ownerSaveSiteEmail(null, fd);
        })}>Сохранить</Button>
        <label className="flex items-center gap-1.5 text-xs text-slate-600">
          <input
            type="checkbox" className="h-4 w-4" checked={initial.enabled}
            disabled={pending || (!canEnable && !initial.enabled)}
            onChange={(e) => run(() => ownerToggleSiteEmail(siteId, e.target.checked))}
          />
          {initial.enabled ? "рассылки разрешены" : "рассылки запрещены"}
        </label>
      </div>

      <div className="border-t border-slate-100 pt-2">
        <div className="mb-1 text-[11px] text-slate-400">Brevo Template ID по событиям (пусто = письмо для события не отправляется)</div>
        <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
          {triggers.map((t) => (
            <TemplateRow
              key={t.type}
              siteId={siteId}
              triggerType={t.type}
              label={t.label}
              initialValue={initial.templates[t.type]}
              disabled={pending}
              onDone={(r) => setMsg(r.error ? { ok: false, text: r.error } : { ok: true, text: r.message ?? "Готово" })}
            />
          ))}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 pt-2">
        <input value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder="адрес для тестового письма" className={`${input} min-w-52 flex-1`} />
        <Button size="sm" variant="outline" disabled={pending || !testTo.trim()} onClick={() => run(() => ownerSendSiteTestEmail(siteId, testTo))}>
          Отправить тест
        </Button>
      </div>

      {msg && <p className={msg.ok ? "text-[11px] text-emerald-700" : "text-[11px] text-red-600"}>{msg.text}</p>}

      <p className="text-[11px] text-slate-400">
        {canEnable
          ? "Включать рассылки стоит после успешного теста: тест идёт по той же цепочке, что автоматизации."
          : "Чтобы разрешить рассылки: задайте sender email, подтвердите домен в Brevo и сохраните."}
      </p>
      {initial.lastTestAt && !msg && (
        <p className={initial.lastTestStatus === "ok" ? "text-[11px] text-slate-400" : "text-[11px] text-red-600"}>
          Последний тест {new Date(initial.lastTestAt).toLocaleString("ru-RU")}
          {initial.lastTestStatus === "ok" ? " — успешно" : `: ${initial.lastErrorSafe ?? "ошибка"}`}
        </p>
      )}
    </div>
  );
}

/** Отдельная строка шаблона: сохраняется по blur/Enter, чтобы не терять правки других полей. */
function TemplateRow({
  siteId, triggerType, label, initialValue, disabled, onDone,
}: {
  siteId: string;
  triggerType: string;
  label: string;
  initialValue: number | undefined;
  disabled: boolean;
  onDone: (r: { ok?: true; message?: string; error?: string }) => void;
}) {
  const router = useRouter();
  const saved = initialValue === undefined ? "" : String(initialValue);
  const [value, setValue] = useState(saved);
  const [pending, start] = useTransition();

  function save() {
    if (value.trim() === saved) return; // ничего не менялось — не тревожим сервер
    start(async () => {
      onDone(await ownerSaveSiteEmailTemplate(siteId, triggerType, value));
      router.refresh();
    });
  }

  return (
    <label className="flex items-center justify-between gap-2 text-[11px] text-slate-600">
      <span className="truncate" title={label}>{label}</span>
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); e.currentTarget.blur(); } }}
        disabled={disabled || pending}
        inputMode="numeric"
        placeholder="—"
        className="w-16 rounded-md border border-slate-300 px-1.5 py-1 text-right text-sm"
      />
    </label>
  );
}
