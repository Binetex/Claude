"use client";
import { useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card, CardBody } from "@/components/ui/Card";
import { Button } from "@/components/ui/button";
import { createAutomation, updateAutomation, previewAutomation, sendTestSms, type AutomationInput, type PreviewActionResult } from "./actions";

type TriggerOpt = { type: string; label: string; description: string };
type VarDef = { key: string; label: string; example: string };
type SiteOpt = { id: string; name: string; quoEnabled: boolean };
type OrderOpt = { id: string; orderNumber: string; siteId: string };

type Conditions = { requirePaid?: boolean; excludeCancelledRefunded?: boolean; deliveryToday?: boolean; apartmentPresent?: boolean };

export type AutomationFormInitial = {
  id: string;
  siteId: string;
  name: string;
  active: boolean;
  triggerType: string;
  audience: "CUSTOMER" | "RECIPIENT" | "BOTH";
  delayAmount: number;
  delayUnit: AutomationInput["delayUnit"];
  template: string;
  conditions: Conditions;
};

const DELAY_UNITS: { value: AutomationInput["delayUnit"]; label: string }[] = [
  { value: "IMMEDIATE", label: "Сразу" },
  { value: "MINUTE", label: "минут" },
  { value: "HOUR", label: "часов" },
  { value: "DAY", label: "дней" },
  { value: "WEEK", label: "недель" },
  { value: "MONTH", label: "месяцев" },
];

export function AutomationForm({
  initial,
  sites,
  recentOrders,
  triggers,
  variables,
}: {
  initial: AutomationFormInitial | null;
  sites: SiteOpt[];
  recentOrders: OrderOpt[];
  triggers: TriggerOpt[];
  variables: VarDef[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const [siteId, setSiteId] = useState(initial?.siteId ?? sites[0]?.id ?? "");
  const [name, setName] = useState(initial?.name ?? "");
  const [active, setActive] = useState(initial?.active ?? false);
  const [triggerType, setTriggerType] = useState(initial?.triggerType ?? triggers[0]?.type ?? "");
  const [audience, setAudience] = useState<AutomationInput["audience"]>(initial?.audience ?? "CUSTOMER");
  const [delayUnit, setDelayUnit] = useState<AutomationInput["delayUnit"]>(initial?.delayUnit ?? "IMMEDIATE");
  const [delayAmount, setDelayAmount] = useState<number>(initial?.delayAmount ?? 0);
  const [template, setTemplate] = useState(initial?.template ?? "");
  const [cond, setCond] = useState<Conditions>(initial?.conditions ?? { excludeCancelledRefunded: true });

  const [saveMsg, setSaveMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [preview, setPreview] = useState<PreviewActionResult | null>(null);
  const [previewOrderId, setPreviewOrderId] = useState("");
  const [testPhone, setTestPhone] = useState("");
  const [testMsg, setTestMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const ordersForSite = useMemo(() => recentOrders.filter((o) => o.siteId === siteId), [recentOrders, siteId]);
  const selectedTrigger = triggers.find((t) => t.type === triggerType);
  const siteObj = sites.find((s) => s.id === siteId);

  function insertVar(key: string) {
    const token = `{{${key}}}`;
    const el = textareaRef.current;
    if (!el) { setTemplate((t) => t + token); return; }
    const startPos = el.selectionStart ?? template.length;
    const endPos = el.selectionEnd ?? template.length;
    const next = template.slice(0, startPos) + token + template.slice(endPos);
    setTemplate(next);
    requestAnimationFrame(() => { el.focus(); const pos = startPos + token.length; el.setSelectionRange(pos, pos); });
  }

  function buildInput(): AutomationInput {
    return {
      siteId,
      name,
      active,
      triggerType,
      audience,
      delayAmount: delayUnit === "IMMEDIATE" ? 0 : Math.max(0, Math.floor(Number(delayAmount) || 0)),
      delayUnit,
      template,
      conditions: cond,
    };
  }

  function save() {
    setSaveMsg(null);
    start(async () => {
      const input = buildInput();
      const res = initial ? await updateAutomation(initial.id, input) : await createAutomation(input);
      if (res.error) { setSaveMsg({ ok: false, text: res.error }); return; }
      if (res.warning) { setSaveMsg({ ok: true, text: `Сохранено. ${res.warning}` }); }
      // Небольшая пауза, чтобы показать предупреждение; иначе сразу к списку.
      if (res.warning) return;
      router.push("/dashboard/sms-marketing");
      router.refresh();
    });
  }

  function runPreview() {
    setPreview(null);
    start(async () => setPreview(await previewAutomation(previewOrderId, template, audience)));
  }

  function runTest() {
    setTestMsg(null);
    start(async () => {
      const r = await sendTestSms(siteId, testPhone, template);
      setTestMsg(r?.error ? { ok: false, text: r.error } : { ok: true, text: "Тестовое SMS отправлено" });
    });
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-slate-800">{initial ? "Редактирование автоматизации" : "Новая автоматизация"}</h1>
        <Button variant="ghost" size="sm" onClick={() => router.push("/dashboard/sms-marketing")}>← К списку</Button>
      </div>

      <Card>
        <CardBody className="space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="space-y-1">
              <span className="text-xs text-slate-500">Название</span>
              <input value={name} onChange={(e) => setName(e.target.value)} className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm" placeholder="Спасибо за заказ" />
            </label>
            <label className="space-y-1">
              <span className="text-xs text-slate-500">Магазин</span>
              <select value={siteId} onChange={(e) => setSiteId(e.target.value)} disabled={!!initial} className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm disabled:bg-slate-50">
                {sites.map((s) => <option key={s.id} value={s.id}>{s.name}{s.quoEnabled ? "" : " (QUO выключен)"}</option>)}
              </select>
            </label>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="space-y-1">
              <span className="text-xs text-slate-500">Событие (триггер)</span>
              <select value={triggerType} onChange={(e) => setTriggerType(e.target.value)} className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm">
                {triggers.map((t) => <option key={t.type} value={t.type}>{t.label}</option>)}
              </select>
              {selectedTrigger && <span className="text-[11px] text-slate-400">{selectedTrigger.description}</span>}
            </label>
            <label className="space-y-1">
              <span className="text-xs text-slate-500">Аудитория</span>
              <select value={audience} onChange={(e) => setAudience(e.target.value as AutomationInput["audience"])} className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm">
                <option value="CUSTOMER">Заказчик</option>
                <option value="RECIPIENT">Получатель</option>
                <option value="BOTH">Оба (при совпадении номера — одно сообщение)</option>
              </select>
            </label>
          </div>

          <div className="space-y-1">
            <span className="text-xs text-slate-500">Задержка</span>
            <div className="flex items-center gap-2">
              {delayUnit !== "IMMEDIATE" && (
                <input type="number" min={0} value={delayAmount} onChange={(e) => setDelayAmount(Number(e.target.value))} className="w-24 rounded-md border border-slate-300 px-2 py-1.5 text-sm" />
              )}
              <select value={delayUnit} onChange={(e) => setDelayUnit(e.target.value as AutomationInput["delayUnit"])} className="rounded-md border border-slate-300 px-2 py-1.5 text-sm">
                {DELAY_UNITS.map((u) => <option key={u.value} value={u.value}>{u.label}</option>)}
              </select>
            </div>
          </div>

          {/* Условия */}
          <div className="space-y-1">
            <span className="text-xs text-slate-500">Условия</span>
            <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input type="checkbox" className="h-4 w-4" checked={cond.excludeCancelledRefunded !== false} onChange={(e) => setCond((c) => ({ ...c, excludeCancelledRefunded: e.target.checked }))} />
                Исключить отменённые/возвраты
              </label>
              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input type="checkbox" className="h-4 w-4" checked={!!cond.requirePaid} onChange={(e) => setCond((c) => ({ ...c, requirePaid: e.target.checked }))} />
                Только оплаченные
              </label>
              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input type="checkbox" className="h-4 w-4" checked={!!cond.deliveryToday} onChange={(e) => setCond((c) => ({ ...c, deliveryToday: e.target.checked }))} />
                Доставка сегодня
              </label>
              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input type="checkbox" className="h-4 w-4" checked={!!cond.apartmentPresent} onChange={(e) => setCond((c) => ({ ...c, apartmentPresent: e.target.checked }))} />
                Указан номер квартиры/юнита
              </label>
            </div>
          </div>

          {/* Шаблон + переменные */}
          <div className="space-y-2">
            <span className="text-xs text-slate-500">Текст SMS</span>
            <textarea ref={textareaRef} value={template} onChange={(e) => setTemplate(e.target.value)} rows={6} maxLength={1600} className="w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-sm" placeholder="Hi {{recipient_name}}, your flower delivery from {{store_name}} is on the way. Track: {{tracking_url}}" />
            <div className="text-right text-[11px] text-slate-400">{template.length}/1600</div>
            <div className="flex flex-wrap gap-1">
              {variables.map((v) => (
                <button key={v.key} type="button" onClick={() => insertVar(v.key)} title={v.label} className="rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 font-mono text-[11px] text-slate-600 hover:bg-slate-100">
                  {`{{${v.key}}}`}
                </button>
              ))}
            </div>
          </div>

          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input type="checkbox" className="h-4 w-4" checked={active} onChange={(e) => setActive(e.target.checked)} />
            Включить сразу (Active)
          </label>

          <div className="flex items-center gap-2 border-t border-slate-100 pt-3">
            <Button size="sm" disabled={pending} onClick={save}>{initial ? "Сохранить" : "Создать"}</Button>
            {saveMsg && <span className={saveMsg.ok ? "text-xs text-emerald-700" : "text-xs text-red-600"}>{saveMsg.text}</span>}
            {saveMsg?.ok && initial && <Button size="sm" variant="ghost" onClick={() => { router.push("/dashboard/sms-marketing"); router.refresh(); }}>К списку</Button>}
          </div>
        </CardBody>
      </Card>

      {/* Preview */}
      <Card>
        <CardBody className="space-y-2">
          <h2 className="text-sm font-semibold text-slate-800">Preview на реальном заказе</h2>
          <div className="flex flex-wrap items-center gap-2">
            <select value={previewOrderId} onChange={(e) => setPreviewOrderId(e.target.value)} className="min-w-[220px] flex-1 rounded-md border border-slate-300 px-2 py-1.5 text-sm">
              <option value="">Выберите заказ…</option>
              {ordersForSite.map((o) => <option key={o.id} value={o.id}>{o.orderNumber}</option>)}
            </select>
            <Button size="sm" variant="outline" disabled={pending || !previewOrderId} onClick={runPreview}>Показать preview</Button>
          </div>
          {ordersForSite.length === 0 && <p className="text-[11px] text-slate-400">Нет недавних заказов для выбранного магазина.</p>}
          {preview && !preview.ok && <p className="text-sm text-red-600">{preview.error}</p>}
          {preview && preview.ok && (
            <div className="space-y-2 rounded-md border border-slate-200 bg-slate-50 p-3">
              <div className="text-xs text-slate-500">Заказ {preview.orderNumber}</div>
              <pre className="whitespace-pre-wrap font-sans text-sm text-slate-800">{preview.text || "(пустой текст)"}</pre>
              <div className="text-[11px] text-slate-500">Адресаты: {preview.recipients.length ? preview.recipients.join("; ") : "—"}</div>
              {preview.skipped.length > 0 && <div className="text-[11px] text-amber-600">Пропущены: {preview.skipped.join("; ")}</div>}
              {preview.missing.length > 0 && <div className="text-[11px] text-amber-600">Недоступные переменные: {preview.missing.join(", ")}</div>}
            </div>
          )}
        </CardBody>
      </Card>

      {/* Test send */}
      <Card>
        <CardBody className="space-y-2">
          <h2 className="text-sm font-semibold text-slate-800">Отправить тест</h2>
          <p className="text-[11px] text-slate-500">Отправляется с номера магазина на введённый номер. Не создаёт задачу и не пишется в историю заказа.</p>
          <div className="flex flex-wrap items-center gap-2">
            <input value={testPhone} onChange={(e) => setTestPhone(e.target.value)} placeholder="+1310…" className="rounded-md border border-slate-300 px-2 py-1.5 text-sm" />
            <Button size="sm" variant="outline" disabled={pending || !testPhone.trim() || !siteObj?.quoEnabled} onClick={runTest}>Отправить тест</Button>
            {!siteObj?.quoEnabled && <span className="text-[11px] text-amber-600">QUO выключен у магазина</span>}
            {testMsg && <span className={testMsg.ok ? "text-xs text-emerald-700" : "text-xs text-red-600"}>{testMsg.text}</span>}
          </div>
        </CardBody>
      </Card>
    </div>
  );
}
