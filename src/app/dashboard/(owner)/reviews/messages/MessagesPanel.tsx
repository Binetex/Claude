"use client";
import { useState, useTransition } from "react";
import { MessageSquare } from "lucide-react";
import { Card, CardHeader, CardTitle, CardBody } from "@/components/ui/Card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { saveReviewSettingsAction } from "./actions";

export type SiteSettings = {
  siteId: string;
  siteName: string;
  askSmsTemplate: string;
  askBrevoTemplateId: string;
  reminderSmsTemplate: string;
  reminderBrevoTemplateId: string;
  promiseWaitDays: string;
  maxCallAttempts: string;
  callRetryDays: string;
};

/**
 * Настройка того, что увидит клиент, и сроков, по которым работает воронка.
 *
 * Пустое поле текста — это «работает текст по умолчанию», и он показан подсказкой прямо в поле:
 * иначе владелец не знает, что именно уходит клиенту, пока не отправит первое сообщение.
 */
export function MessagesPanel({
  sites,
  defaults,
  variables,
}: {
  sites: SiteSettings[];
  defaults: { ask: string; reminder: string };
  variables: { key: string; label: string }[];
}) {
  return (
    <div className="space-y-4">
      {sites.map((s) => (
        <SiteCard key={s.siteId} site={s} defaults={defaults} variables={variables} />
      ))}
    </div>
  );
}

function SiteCard({
  site,
  defaults,
  variables,
}: {
  site: SiteSettings;
  defaults: { ask: string; reminder: string };
  variables: { key: string; label: string }[];
}) {
  const [form, setForm] = useState(site);
  const [msg, setMsg] = useState<{ kind: "ok" | "warn" | "err"; text: string } | null>(null);
  const [pending, start] = useTransition();

  const set = (field: keyof SiteSettings) => (value: string) => {
    setForm((f) => ({ ...f, [field]: value }));
    setMsg(null);
  };

  function save() {
    start(async () => {
      const res = await saveReviewSettingsAction(site.siteId, {
        askSmsTemplate: form.askSmsTemplate,
        askBrevoTemplateId: form.askBrevoTemplateId,
        reminderSmsTemplate: form.reminderSmsTemplate,
        reminderBrevoTemplateId: form.reminderBrevoTemplateId,
        promiseWaitDays: form.promiseWaitDays,
        maxCallAttempts: form.maxCallAttempts,
        callRetryDays: form.callRetryDays,
      });
      if (res.error) setMsg({ kind: "err", text: res.error });
      else if (res.warning) setMsg({ kind: "warn", text: `Сохранено. ${res.warning}` });
      else setMsg({ kind: "ok", text: "Сохранено" });
    });
  }

  return (
    <Card>
      <CardHeader className="py-2.5">
        <CardTitle icon={MessageSquare}>{site.siteName}</CardTitle>
      </CardHeader>
      <CardBody className="space-y-4 py-3">
        <MessageField
          title="Просьба об отзыве"
          hint="Уходит клиенту, когда оператор нажимает «Отправить ссылку» — и сама, когда попытки дозвониться исчерпаны."
          value={form.askSmsTemplate}
          placeholder={defaults.ask}
          onChange={set("askSmsTemplate")}
          brevoId={form.askBrevoTemplateId}
          onBrevoId={set("askBrevoTemplateId")}
          disabled={pending}
          variables={variables}
        />

        <MessageField
          title="Напоминание"
          hint="Уходит само, если клиент обещал оставить отзыв и пропал."
          value={form.reminderSmsTemplate}
          placeholder={defaults.reminder}
          onChange={set("reminderSmsTemplate")}
          brevoId={form.reminderBrevoTemplateId}
          onBrevoId={set("reminderBrevoTemplateId")}
          disabled={pending}
          variables={variables}
        />

        <div className="flex flex-wrap items-end gap-4 border-t border-slate-100 pt-3">
          <NumberField label="Попыток звонка" hint="Дальше система шлёт ссылку сама" value={form.maxCallAttempts} onChange={set("maxCallAttempts")} disabled={pending} />
          <NumberField label="Перезвонить через, дней" value={form.callRetryDays} onChange={set("callRetryDays")} disabled={pending} />
          <NumberField label="Ждать обещанный отзыв, дней" hint="Потом уйдёт напоминание" value={form.promiseWaitDays} onChange={set("promiseWaitDays")} disabled={pending} />
          <div className="ml-auto flex items-center gap-3">
            {msg && (
              <span
                className={`text-xs ${msg.kind === "err" ? "text-red-600" : msg.kind === "warn" ? "text-amber-700" : "text-emerald-700"}`}
              >
                {msg.text}
              </span>
            )}
            <Button size="sm" onClick={save} disabled={pending}>
              Сохранить
            </Button>
          </div>
        </div>
      </CardBody>
    </Card>
  );
}

function MessageField({
  title,
  hint,
  value,
  placeholder,
  onChange,
  brevoId,
  onBrevoId,
  disabled,
  variables,
}: {
  title: string;
  hint: string;
  value: string;
  placeholder: string;
  onChange: (v: string) => void;
  brevoId: string;
  onBrevoId: (v: string) => void;
  disabled: boolean;
  variables: { key: string; label: string }[];
}) {
  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-sm font-medium text-slate-800">{title}</span>
        <span className="text-xs text-slate-500">{hint}</span>
      </div>

      <Textarea
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        rows={3}
        className="mt-1.5 text-sm"
      />
      <p className="mt-1 text-[11px] text-slate-500">
        Пусто — уходит текст по умолчанию, он показан серым прямо в поле. Пишите{" "}
        <b>по-английски</b>: клиенты англоязычные.
      </p>

      {/* Вставка переменной курсором мимо: короткий список рядом надёжнее, чем память. */}
      <div className="mt-1.5 flex flex-wrap gap-1">
        {variables.map((v) => (
          <button
            key={v.key}
            type="button"
            disabled={disabled}
            onClick={() => onChange(`${value || ""}{{${v.key}}}`)}
            title={v.label}
            className="rounded border border-slate-200 bg-slate-50 px-1.5 py-px font-mono text-[11px] text-slate-600 hover:border-slate-300"
          >
            {`{{${v.key}}}`}
          </button>
        ))}
      </div>

      <label className="mt-2 flex items-center gap-2 text-xs text-slate-600">
        Brevo Template ID для письма
        <Input
          value={brevoId}
          onChange={(e) => onBrevoId(e.target.value)}
          disabled={disabled}
          placeholder="напр. 12"
          className="h-8 w-24 font-mono text-xs"
        />
        <span className="text-[11px] text-slate-400">письмо уходит, когда SMS не смогла</span>
      </label>
    </div>
  );
}

function NumberField({
  label,
  hint,
  value,
  onChange,
  disabled,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
}) {
  return (
    <label className="block text-xs text-slate-600">
      {label}
      <Input value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} className="mt-1 h-8 w-20 text-sm" />
      {hint && <span className="mt-0.5 block text-[11px] text-slate-400">{hint}</span>}
    </label>
  );
}
