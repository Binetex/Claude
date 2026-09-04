"use client";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { ownerSetSiteAiSettings } from "./actions";
import { INTENTS } from "@/modules/assistant/intents";
import { readTemplates, type TemplateSetting } from "@/modules/assistant/templates";

type Mode = "OFF" | "DRAFT" | "AUTO_SIMPLE";

const MODES: { value: Mode; label: string; hint: string }[] = [
  { value: "OFF", label: "Выключен", hint: "Входящие обрабатываются как раньше." },
  { value: "DRAFT", label: "Готовит черновики", hint: "Отвечает человек, ассистент только предлагает текст." },
  { value: "AUTO_SIMPLE", label: "Простое отвечает сам", hint: "Сложное, важное и неуверенное всё равно уходит человеку." },
];

/**
 * Ассистент клиентской переписки на магазине.
 *
 * Сухой прогон стоит отдельной галочкой и по умолчанию включён: «включу и посмотрю» одним
 * кликом не должно выпускать ответы живым клиентам. Пока он стоит, ассистент работает целиком —
 * читает, думает, пишет черновики, — но наружу не уходит ничего.
 */
export function SiteAiAssistantPanel({
  siteId,
  initial,
}: {
  siteId: string;
  initial: {
    mode: Mode;
    dryRun: boolean;
    knowledgeBase: string | null;
    unknownKnowledgeBase: string | null;
    templates: unknown;
  };
}) {
  const [mode, setMode] = useState<Mode>(initial.mode);
  const [dryRun, setDryRun] = useState(initial.dryRun);
  const [kb, setKb] = useState(initial.knowledgeBase ?? "");
  const [unknownKb, setUnknownKb] = useState(initial.unknownKnowledgeBase ?? "");
  const [templates, setTemplates] = useState<Record<string, TemplateSetting>>(() => readTemplates(initial.templates));
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();

  const initialTemplates = readTemplates(initial.templates);
  const templatesDirty = INTENTS.some(
    (i) => templates[i.key].enabled !== initialTemplates[i.key].enabled || templates[i.key].text.trim() !== initialTemplates[i.key].text.trim()
  );
  const setTemplate = (key: string, patch: Partial<TemplateSetting>) => {
    setTemplates((prev) => ({ ...prev, [key]: { ...prev[key], ...patch } }));
    setMsg(null);
  };

  const dirty =
    mode !== initial.mode ||
    dryRun !== initial.dryRun ||
    kb.trim() !== (initial.knowledgeBase ?? "").trim() ||
    unknownKb.trim() !== (initial.unknownKnowledgeBase ?? "").trim() ||
    templatesDirty;

  const save = () =>
    start(async () => {
      const r = await ownerSetSiteAiSettings(siteId, { mode, dryRun, knowledgeBase: kb, unknownKnowledgeBase: unknownKb, templates });
      // Сервер перевёл русские заготовки — показываем то, что реально сохранилось.
      if (r?.ok && r.templates) setTemplates((prev) => ({ ...prev, ...r.templates }));
      setMsg(r?.ok ? { ok: true, text: r.message ?? "Сохранено" } : { ok: false, text: r?.error ?? "Ошибка" });
    });

  return (
    <div className="space-y-3">
      <div>
        <div className="text-xs text-slate-400">Ассистент клиентской переписки</div>
        <p className="text-[11px] text-slate-400">
          Отвечает на входящие SMS и расшифровки звонков. Клиенту пишет только по-английски.
        </p>
      </div>

      <div className="space-y-1.5">
        {MODES.map((m) => (
          <label key={m.value} className="flex items-start gap-2 text-sm text-slate-700">
            <input
              type="radio"
              name={`ai-mode-${siteId}`}
              className="mt-1"
              checked={mode === m.value}
              onChange={() => { setMode(m.value); setMsg(null); }}
            />
            <span>
              {m.label}
              <span className="block text-[11px] text-slate-400">{m.hint}</span>
            </span>
          </label>
        ))}
      </div>

      {mode !== "OFF" && (
        <>
          <label className="flex items-start gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              className="mt-1"
              checked={dryRun}
              onChange={(e) => { setDryRun(e.target.checked); setMsg(null); }}
            />
            <span>
              Сухой прогон
              <span className="block text-[11px] text-slate-400">
                Ассистент работает, черновики приходят в Telegram с пометкой «сухой прогон», кнопки и реплаи можно проверять — но клиенту не уходит ничего. Снимать после недели наблюдения.
              </span>
            </span>
          </label>

          <div className="space-y-1">
            <div className="text-xs text-slate-400">База знаний — клиенты с заказом</div>
            <textarea
              value={kb}
              onChange={(e) => { setKb(e.target.value); setMsg(null); }}
              rows={5}
              placeholder="Часы работы, зоны доставки, как переносится доставка, что делать при отсутствии получателя…"
              className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
              aria-label="База знаний для клиентов с заказом"
            />
          </div>

          <div className="space-y-1">
            <div className="text-xs text-slate-400">База знаний — незнакомые номера</div>
            <p className="text-[11px] text-slate-400">
              Другой разговор: заказа нет. Сначала выясняет, о каком заказе речь, потом отвечает отсюда.
            </p>
            <textarea
              value={unknownKb}
              onChange={(e) => { setUnknownKb(e.target.value); setMsg(null); }}
              rows={4}
              placeholder="Как сделать заказ, цены, доставка в тот же день, часы работы…"
              className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
              aria-label="База знаний для незнакомых номеров"
            />
          </div>
        </>
      )}

      {mode !== "OFF" && (
        <div className="space-y-2">
          <div>
            <div className="text-xs text-slate-400">Готовые ответы на частые вопросы</div>
            <p className="text-[11px] text-slate-400">
              Совпал вопрос — уходит этот текст, модель не вызывается вообще. Если нужного значения в
              заказе нет (например, трека), заготовка пропускается и отвечает модель.
            </p>
          </div>
          {INTENTS.map((i) => (
            <div key={i.key} className="rounded-md border border-slate-200 px-2.5 py-2">
              <label className="flex items-start gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={templates[i.key].enabled}
                  onChange={(e) => setTemplate(i.key, { enabled: e.target.checked })}
                />
                <span>
                  {i.label}
                  <span className="block text-[11px] text-slate-400">{i.hint}</span>
                </span>
              </label>
              {templates[i.key].enabled && (
                <textarea
                  value={templates[i.key].text}
                  onChange={(e) => setTemplate(i.key, { text: e.target.value })}
                  rows={2}
                  className="mt-1.5 w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
                  aria-label={`Текст ответа: ${i.label}`}
                />
              )}
            </div>
          ))}
          <p className="text-[11px] text-slate-400">
            Переменные: {"{{tracking_url}}"}, {"{{delivery_time}}"}, {"{{delivery_date}}"}, {"{{order_number}}"},
            {" "}{"{{recipient_name}}"}, {"{{store_name}}"}. Текст — только по-английски.
          </p>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" variant="outline" disabled={pending || !dirty} onClick={save}>
          Сохранить
        </Button>
        {msg && <span className={msg.ok ? "text-xs text-emerald-700" : "text-xs text-red-600"}>{msg.text}</span>}
      </div>
    </div>
  );
}
