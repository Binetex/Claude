"use client";
import { useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card, CardBody } from "@/components/ui/Card";
import { Button } from "@/components/ui/button";
import {
  createAutomation,
  updateAutomation,
  previewAutomation,
  sendTestSms,
  checkSiteEmailTemplate,
  type AutomationInput,
  type PreviewActionResult,
  type SiteEmailTemplateStatus,
} from "./actions";
import { SiteMultiSelect, type SiteOption } from "./SiteMultiSelect";
import { WAIT_UNITS, splitWait, joinWait, type WaitUnit } from "@/modules/automations/chain";

type TriggerOpt = { type: string; label: string; description: string };
type VarDef = { key: string; label: string; example: string };
type SiteOpt = SiteOption;
type OrderOpt = { id: string; orderNumber: string; siteId: string };

type Conditions = { requirePaid?: boolean; excludeCancelledRefunded?: boolean; apartmentPresent?: boolean };

export type AutomationFormInitial = {
  id: string;
  siteIds: string[];
  name: string;
  active: boolean;
  smsEnabled: boolean;
  emailEnabled: boolean;
  emailFallbackEnabled: boolean;
  brevoTemplateId: number | null;
  triggerType: string;
  audience: "CUSTOMER" | "RECIPIENT" | "BOTH";
  delayAmount: number;
  delayUnit: AutomationInput["delayUnit"];
  template: string;
  conditions: Conditions;
  noReplyNextAutomationId?: string | null;
  noReplyAfterMin?: number | null;
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
  /** Остальные правила — из них выбирается следующий шаг цепочки «не ответили». */
  otherAutomations = [],
  // На странице правила заголовок и «назад» уже есть над подвкладками — второй был бы дублем.
  showHeader = true,
}: {
  initial: AutomationFormInitial | null;
  sites: SiteOpt[];
  recentOrders: OrderOpt[];
  triggers: TriggerOpt[];
  variables: VarDef[];
  otherAutomations?: { id: string; name: string; active: boolean; deleted?: boolean; siteNames: string[] }[];
  showHeader?: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const [siteIds, setSiteIds] = useState<string[]>(initial?.siteIds ?? []);
  const [name, setName] = useState(initial?.name ?? "");
  const [active, setActive] = useState(initial?.active ?? false);
  const [smsEnabled, setSmsEnabled] = useState(initial?.smsEnabled ?? true);
  const [emailEnabled, setEmailEnabled] = useState(initial?.emailEnabled ?? false);
  const [emailFallbackEnabled, setEmailFallbackEnabled] = useState(initial?.emailFallbackEnabled ?? false);
  // Строкой (не числом) — чтобы поле можно было временно очистить при редактировании без NaN.
  const [brevoTemplateIdInput, setBrevoTemplateIdInput] = useState(initial?.brevoTemplateId != null ? String(initial.brevoTemplateId) : "");
  const [triggerType, setTriggerType] = useState(initial?.triggerType ?? triggers[0]?.type ?? "");
  const [audience, setAudience] = useState<AutomationInput["audience"]>(initial?.audience ?? "CUSTOMER");
  const [delayUnit, setDelayUnit] = useState<AutomationInput["delayUnit"]>(initial?.delayUnit ?? "IMMEDIATE");
  const [delayAmount, setDelayAmount] = useState<number>(initial?.delayAmount ?? 0);
  const [template, setTemplate] = useState(initial?.template ?? "");
  const [cond, setCond] = useState<Conditions>(initial?.conditions ?? { excludeCancelledRefunded: true });
  const [noReplyNextId, setNoReplyNextId] = useState<string>(initial?.noReplyNextAutomationId ?? "");
  // Срок ожидания у ЭТОГО правила: пусто — берётся из настроек магазина. Храним минутами,
  // показываем парой «сколько + единица», чтобы «через 2 дня» не приходилось считать в уме.
  const initialWait = initial?.noReplyAfterMin != null ? splitWait(initial.noReplyAfterMin) : null;
  const [waitAmount, setWaitAmount] = useState<string>(initialWait ? String(initialWait.amount) : "");
  const [waitUnit, setWaitUnit] = useState<WaitUnit>(initialWait?.unit ?? "MINUTE");
  // Ответ узнаём по входящим на номер, поэтому ждать его можно только у SMS. То же условие
  // режет сервер при сохранении — форму можно обойти.
  const awaitReplyAvailable = smsEnabled;

  const [saveMsg, setSaveMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [preview, setPreview] = useState<PreviewActionResult | null>(null);
  const [previewOrderId, setPreviewOrderId] = useState("");
  const [testPhone, setTestPhone] = useState("");
  const [testMsg, setTestMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // Preview и тестовая отправка всегда идут по ОДНОМУ магазину — выбирается отдельно из привязанных.
  const [sandboxSiteId, setSandboxSiteId] = useState<string>(initial?.siteIds[0] ?? "");
  const selectedSites = useMemo(() => sites.filter((s) => siteIds.includes(s.id)), [sites, siteIds]);

  // Статус Email-шаблона выбранного (для preview/test) магазина под текущее событие. Настройки
  // отправителя/домена/Template ID живут в /dashboard/sites — здесь только READ-ONLY индикация,
  // чтобы не дублировать источник истины в самом правиле. Запрашивается явно (не в useEffect —
  // setState в эффекте здесь запрещён линтером) при каждом изменении входных данных проверки.
  const [emailStatus, setEmailStatus] = useState<SiteEmailTemplateStatus | null>(null);
  const [, startEmailStatusCheck] = useTransition();
  function refreshEmailStatus(siteId: string, trigger: string, wantEmail: boolean, ruleTemplateId: number | null) {
    if (!wantEmail || !siteId || !trigger) { setEmailStatus(null); return; }
    startEmailStatusCheck(async () => setEmailStatus(await checkSiteEmailTemplate(siteId, trigger, ruleTemplateId)));
  }

  /** null = не задан (используется шаблон магазина); NaN/невалидное — тоже null, сервер отдельно провалидирует. */
  function parsedTemplateId(raw: string): number | null {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    const n = Number(trimmed);
    return Number.isInteger(n) && n > 0 ? n : null;
  }

  /** Магазин убрали из правила → сбрасываем выбор песочницы (и заказ/preview вместе с ним). */
  function changeSiteIds(next: string[]) {
    setSiteIds(next);
    if (sandboxSiteId && !next.includes(sandboxSiteId)) resetSandbox("");
  }

  function resetSandbox(siteId: string) {
    setSandboxSiteId(siteId);
    setPreviewOrderId("");
    setPreview(null);
    refreshEmailStatus(siteId, triggerType, emailEnabled || emailFallbackEnabled, parsedTemplateId(brevoTemplateIdInput));
  }

  const ordersForSite = useMemo(() => recentOrders.filter((o) => o.siteId === sandboxSiteId), [recentOrders, sandboxSiteId]);
  const selectedTrigger = triggers.find((t) => t.type === triggerType);
  const sandboxSite = sites.find((s) => s.id === sandboxSiteId);

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
      siteIds,
      name,
      active,
      smsEnabled,
      emailEnabled,
      emailFallbackEnabled: smsEnabled && emailFallbackEnabled,
      brevoTemplateId: emailEnabled || emailFallbackEnabled ? parsedTemplateId(brevoTemplateIdInput) : null,
      triggerType,
      audience,
      delayAmount: delayUnit === "IMMEDIATE" ? 0 : Math.max(0, Math.floor(Number(delayAmount) || 0)),
      delayUnit,
      template,
      conditions: cond,
      // Ждать ответа имеет смысл только там, где сообщение реально уходит по SMS.
      noReplyNextAutomationId: awaitReplyAvailable && noReplyNextId ? noReplyNextId : null,
      noReplyAfterMin: waitAmount.trim() && Number(waitAmount) > 0 ? joinWait(Number(waitAmount), waitUnit) : null,
    };
  }

  /**
   * Fallback и ожидание ответа имеют смысл только при включённом SMS — гасим их вместе с SMS.
   * Именно гасим, а не срезаем при сохранении: иначе владелец видит в поле выбранное правило,
   * жмёт «Сохранить», получает зелёное «Сохранено» — и цепочка исчезает молча.
   */
  function setSms(v: boolean) {
    setSmsEnabled(v);
    if (!v) {
      setEmailFallbackEnabled(false);
      setNoReplyNextId("");
    }
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
      router.push("/dashboard/automations");
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
      const r = await sendTestSms(sandboxSiteId, testPhone, template);
      setTestMsg(r?.error ? { ok: false, text: r.error } : { ok: true, text: "Тестовое SMS отправлено" });
    });
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      {showHeader && (
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-bold text-slate-800">{initial ? "Редактирование автоматизации" : "Новая автоматизация"}</h1>
          <Button variant="ghost" size="sm" onClick={() => router.push("/dashboard/automations")}>← К списку</Button>
        </div>
      )}

      <Card>
        <CardBody className="space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="space-y-1">
              <span className="text-xs text-slate-500">Название</span>
              <input value={name} onChange={(e) => setName(e.target.value)} className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm" placeholder="Спасибо за заказ" />
            </label>
            <div className="space-y-1">
              <span className="text-xs text-slate-500">Магазины</span>
              <SiteMultiSelect sites={sites} selected={siteIds} onChange={changeSiteIds} />
              <span className="block text-[11px] text-slate-400">Шаблон, триггер, аудитория, задержка и условия — общие для всех выбранных магазинов.</span>
            </div>
          </div>

          <div className="space-y-1">
            <span className="text-xs text-slate-500">Каналы</span>
            <div className="flex flex-wrap items-center gap-4 rounded-md border border-slate-200 px-3 py-2">
              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input type="checkbox" className="h-4 w-4" checked={smsEnabled} onChange={(e) => setSms(e.target.checked)} />
                SMS
              </label>
              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input
                  type="checkbox" className="h-4 w-4" checked={emailEnabled}
                  onChange={(e) => { setEmailEnabled(e.target.checked); refreshEmailStatus(sandboxSiteId, triggerType, e.target.checked || emailFallbackEnabled, parsedTemplateId(brevoTemplateIdInput)); }}
                />
                Email
              </label>
              {smsEnabled && (
                <label className="flex items-center gap-2 text-sm text-slate-700">
                  <input
                    type="checkbox" className="h-4 w-4" checked={emailFallbackEnabled}
                    onChange={(e) => { setEmailFallbackEnabled(e.target.checked); refreshEmailStatus(sandboxSiteId, triggerType, emailEnabled || e.target.checked, parsedTemplateId(brevoTemplateIdInput)); }}
                  />
                  Email, если SMS недоступно
                </label>
              )}
            </div>
            {(emailEnabled || emailFallbackEnabled) && (
              <div className="space-y-1">
                <label className="flex items-center gap-2 text-xs text-slate-500">
                  Brevo Template ID этого правила (необязательно)
                  <input
                    value={brevoTemplateIdInput}
                    onChange={(e) => setBrevoTemplateIdInput(e.target.value)}
                    onBlur={() => refreshEmailStatus(sandboxSiteId, triggerType, true, parsedTemplateId(brevoTemplateIdInput))}
                    inputMode="numeric"
                    placeholder="пусто = шаблон магазина по умолчанию"
                    className="w-64 rounded-md border border-slate-300 px-2 py-1 text-sm text-slate-700"
                  />
                </label>
                <EmailReadinessHint status={emailStatus} siteChosen={!!sandboxSiteId} siteName={sandboxSite?.name} />
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="space-y-1">
              <span className="text-xs text-slate-500">Событие (триггер)</span>
              <select
                value={triggerType}
                onChange={(e) => { setTriggerType(e.target.value); refreshEmailStatus(sandboxSiteId, e.target.value, emailEnabled || emailFallbackEnabled, parsedTemplateId(brevoTemplateIdInput)); }}
                className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
              >
                {triggers.map((t) => <option key={t.type} value={t.type}>{t.label}</option>)}
              </select>
              {selectedTrigger && <span className="text-[11px] text-slate-400">{selectedTrigger.description}</span>}
            </label>
            <label className="space-y-1">
              <span className="text-xs text-slate-500">Аудитория (SMS)</span>
              <select value={audience} onChange={(e) => setAudience(e.target.value as AutomationInput["audience"])} className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm">
                <option value="CUSTOMER">Заказчик</option>
                <option value="RECIPIENT">Получатель</option>
                <option value="BOTH">Оба (при совпадении номера — одно сообщение заказчику)</option>
              </select>
              <span className="text-[11px] text-slate-400">Email всегда идёт заказчику (email получателя цветов в заказе не хранится).</span>
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
                <input type="checkbox" className="h-4 w-4" checked={!!cond.apartmentPresent} onChange={(e) => setCond((c) => ({ ...c, apartmentPresent: e.target.checked }))} />
                Указан номер квартиры/юнита
              </label>
            </div>
          </div>

          {/* Цепочка. Отдельно от условий: условия решают, кому слать, а это — что делать,
              если ответа не будет. Ожидание выражается самой ссылкой: ждать, никого не
              запуская, смысла нет. */}
          <div className="space-y-1">
            <span className="text-xs text-slate-500">Если не ответят на это сообщение</span>
            <select
              value={noReplyNextId}
              disabled={!awaitReplyAvailable}
              onChange={(e) => setNoReplyNextId(e.target.value)}
              className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm disabled:bg-slate-50 disabled:text-slate-400"
            >
              <option value="">Ничего не делать</option>
              {/* Правил с похожими именами у разных магазинов бывает несколько (кнопка
                  «Дублировать» плодит копии) — без магазина и состояния выбрать вслепую. */}
              {otherAutomations.map((a) => (
                <option key={a.id} value={a.id}>
                  Запустить: {a.name}
                  {a.siteNames.length ? ` — ${a.siteNames.join(", ")}` : " — магазины не выбраны"}
                  {a.deleted ? " (удалено)" : a.active ? "" : " (выключено)"}
                </option>
              ))}
            </select>
            {/* Срок ожидания у каждого шага свой: вопросу хватает часа, напоминанию нужен день. */}
            {noReplyNextId && awaitReplyAvailable && (
              <label className="flex flex-wrap items-center gap-1.5 text-xs text-slate-600">
                Ждать ответ
                <input
                  type="number"
                  min={1}
                  value={waitAmount}
                  onChange={(e) => setWaitAmount(e.target.value)}
                  placeholder="по умолчанию"
                  className="w-24 rounded-md border border-slate-300 px-1.5 py-1 text-sm text-slate-800"
                />
                <select
                  value={waitUnit}
                  onChange={(e) => setWaitUnit(e.target.value as WaitUnit)}
                  className="rounded-md border border-slate-300 px-1.5 py-1 text-sm text-slate-800"
                >
                  {WAIT_UNITS.map((u) => (
                    <option key={u.value} value={u.value}>
                      {u.label}
                    </option>
                  ))}
                </select>
                <span className="text-slate-400">пусто — срок из настроек магазина</span>
              </label>
            )}
            <p className="text-xs text-slate-500">
              {awaitReplyAvailable ? (
                <>
                  Ответом считается входящее сообщение или звонок с того же номера. Молчит — уйдёт
                  выбранное правило; у него может быть своё продолжение, так собирается лесенка
                  любой длины, и у каждого шага свой срок ожидания.
                </>
              ) : (
                <>Доступно при включённом SMS: ответ мы узнаём по входящим на номер.</>
              )}
            </p>
          </div>

          {/* Шаблон + переменные */}
          <div className="space-y-2">
            <span className="text-xs text-slate-500">Текст SMS{!smsEnabled && " (SMS выключен — текст не используется)"}</span>
            <textarea ref={textareaRef} value={template} onChange={(e) => setTemplate(e.target.value)} rows={6} maxLength={1600} disabled={!smsEnabled} className="w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-sm disabled:bg-slate-50 disabled:text-slate-400" placeholder="Hi {{recipient_name}}, your flower delivery from {{store_name}} is on the way. Track: {{tracking_url}}" />
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
            {saveMsg?.ok && initial && <Button size="sm" variant="ghost" onClick={() => { router.push("/dashboard/automations"); router.refresh(); }}>К списку</Button>}
          </div>
        </CardBody>
      </Card>

      {/* Preview */}
      <Card>
        <CardBody className="space-y-2">
          <h2 className="text-sm font-semibold text-slate-800">Preview на реальном заказе</h2>
          <label className="block space-y-1">
            <span className="text-xs text-slate-500">Магазин для preview / test send</span>
            <select
              value={sandboxSiteId}
              onChange={(e) => resetSandbox(e.target.value)}
              className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm sm:w-72"
            >
              <option value="">Выберите магазин…</option>
              {selectedSites.map((s) => <option key={s.id} value={s.id}>{s.name}{s.quoEnabled ? "" : " (QUO выключен)"}</option>)}
            </select>
          </label>
          {selectedSites.length === 0 && <p className="text-[11px] text-slate-400">Сначала выберите магазины правила выше.</p>}
          <div className="flex flex-wrap items-center gap-2">
            <select value={previewOrderId} onChange={(e) => setPreviewOrderId(e.target.value)} disabled={!sandboxSiteId} className="min-w-[220px] flex-1 rounded-md border border-slate-300 px-2 py-1.5 text-sm disabled:bg-slate-50">
              <option value="">Выберите заказ…</option>
              {ordersForSite.map((o) => <option key={o.id} value={o.id}>{o.orderNumber}</option>)}
            </select>
            <Button size="sm" variant="outline" disabled={pending || !sandboxSiteId || !previewOrderId} onClick={runPreview}>Показать preview</Button>
          </div>
          {sandboxSiteId && ordersForSite.length === 0 && <p className="text-[11px] text-slate-400">Нет недавних заказов для выбранного магазина.</p>}
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
          <p className="text-[11px] text-slate-500">Отправляется с номера магазина, выбранного выше в блоке preview. Не создаёт задачу и не пишется в историю заказа.</p>
          <div className="flex flex-wrap items-center gap-2">
            <input value={testPhone} onChange={(e) => setTestPhone(e.target.value)} placeholder="+1310…" className="rounded-md border border-slate-300 px-2 py-1.5 text-sm" />
            <Button size="sm" variant="outline" disabled={pending || !sandboxSiteId || !testPhone.trim() || !sandboxSite?.quoEnabled} onClick={runTest}>Отправить тест</Button>
            {!sandboxSiteId && <span className="text-[11px] text-slate-400">Выберите магазин для теста</span>}
            {sandboxSiteId && !sandboxSite?.quoEnabled && <span className="text-[11px] text-amber-600">QUO выключен у магазина</span>}
            {testMsg && <span className={testMsg.ok ? "text-xs text-emerald-700" : "text-xs text-red-600"}>{testMsg.text}</span>}
          </div>
        </CardBody>
      </Card>
    </div>
  );
}

const EMAIL_SKIP_LABEL: Record<string, string> = {
  site_or_trigger_missing: "выберите магазин для preview/test выше",
  email_not_configured: "не настроен общий Brevo API key (см. страницу «Сайты»)",
  site_email_disabled: "Email выключен у этого магазина",
  site_email_not_configured: "не задан отправитель у этого магазина",
  site_domain_not_verified: "домен отправителя не подтверждён",
  site_template_missing: "нет Brevo Template ID для этого события у этого магазина",
};

/**
 * Read-only индикатор готовности EMAIL для выбранного (в блоке preview/test) магазина под
 * текущее событие. Настройки отправителя/домена/Template ID редактируются на /dashboard/sites —
 * здесь их сознательно не дублируем, только показываем итог.
 */
function EmailReadinessHint({ status, siteChosen, siteName }: { status: SiteEmailTemplateStatus | null; siteChosen: boolean; siteName?: string }) {
  if (!siteChosen) {
    return <p className="text-[11px] text-amber-600">Для Email выберите магазин в блоке preview/test ниже — по нему проверяется готовность шаблона.</p>;
  }
  if (!status) return null;
  if (status.ready) {
    return (
      <p className="text-[11px] text-emerald-700">
        {status.source === "automation"
          ? `Используется шаблон правила: ID ${status.templateId}.`
          : `Используется шаблон магазина по умолчанию: ID ${status.templateId} (задан на странице «Сайты»).`}
      </p>
    );
  }
  const hint = status.reason === "site_template_missing"
    ? "нет Brevo-шаблона ни в этом правиле, ни у магазина по умолчанию для этого события"
    : EMAIL_SKIP_LABEL[status.reason] ?? status.reason;
  return (
    <p className="text-[11px] text-amber-600">
      Email для «{siteName}» пока не отправится: {hint}. Укажите Template ID выше или настройте магазин на странице «Сайты».
    </p>
  );
}
