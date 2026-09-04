/**
 * Заготовки магазина: включена ли и каким текстом. Чистый модуль — читают и сервер, и форма.
 *
 * Хранится JSON'ом на магазине, но наружу отдаётся уже разобранным: остальному коду не должно
 * быть дела до того, что где-то там `Json?`.
 */
import { renderTemplate, extractVariables } from "@/modules/messaging/template";
import { INTENTS, type IntentDef, type IntentKey, type IntentOrderState } from "./intents";

export type TemplateSetting = { enabled: boolean; text: string };
export type TemplateSettings = Record<string, TemplateSetting>;

/**
 * Разбор настроек магазина. Ничего не задано — заготовки РАБОТАЮТ с текстами по умолчанию:
 * они безобидны и фактологичны, а выключенные по умолчанию заготовки означали бы, что первые
 * недели каждый «где мой заказ» стоит запроса к модели.
 */
export function readTemplates(raw: unknown): Record<IntentKey, TemplateSetting> {
  const stored = (raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {}) as Record<string, unknown>;
  const out = {} as Record<IntentKey, TemplateSetting>;
  for (const def of INTENTS) {
    const item = stored[def.key];
    const obj = item && typeof item === "object" ? (item as Record<string, unknown>) : null;
    const text = obj && typeof obj.text === "string" && obj.text.trim() ? obj.text.trim() : def.defaultText;
    const enabled = obj && typeof obj.enabled === "boolean" ? obj.enabled : true;
    out[def.key] = { enabled, text };
  }
  return out;
}

/** Обратно в JSON для записи. Текст, совпавший с умолчанием, не храним — он и так придёт из кода. */
export function writeTemplates(settings: Record<string, TemplateSetting>): TemplateSettings {
  const out: TemplateSettings = {};
  for (const def of INTENTS) {
    const s = settings[def.key];
    if (!s) continue;
    const text = s.text.trim();
    if (s.enabled && (!text || text === def.defaultText)) continue;
    out[def.key] = { enabled: s.enabled, text: text || def.defaultText };
  }
  return out;
}

/**
 * Можно ли ответить заготовкой: она включена, текст есть, и все нужные ей значения непустые.
 * «Вот ваш трек» без трека — худший из возможных ответов, поэтому проверка обязательна.
 */
export function templateApplies(
  def: IntentDef,
  setting: TemplateSetting,
  vars: Record<string, string>,
  state: IntentOrderState = { deliveryStatus: null, deliveryIsToday: false }
): boolean {
  if (!setting.enabled || !setting.text.trim()) return false;
  if (def.when && !def.when(state)) return false;
  return def.requires.every((key) => !!vars[key]?.trim());
}

export type AssistantRender = { text: string; dropped: string[] };

/**
 * Рендер заготовки ассистента: предложение с пустой переменной выбрасывается ЦЕЛИКОМ, остальные
 * остаются. «Here is your bouquet {{bouquet_photo_url}}. Track here {{tracking_url}}» без трека
 * уходит одним первым предложением — а не молчанием и не фразой с дырой. Границы: перенос
 * строки и конец предложения (. ! ?). Обязательная переменная самой заготовки проверяется
 * раньше, в `templateApplies`.
 */
export function renderAssistantTemplate(text: string, vars: Record<string, string>): AssistantRender {
  const dropped: string[] = [];
  const lines: string[] = [];
  for (const line of text.split("\n")) {
    const kept: string[] = [];
    for (const sentence of line.split(/(?<=[.!?])\s+/)) {
      const missing = extractVariables(sentence).filter((v) => !vars[v]?.trim());
      if (missing.length) {
        dropped.push(...missing);
        continue;
      }
      const r = renderTemplate(sentence, vars).text.trim();
      if (r) kept.push(r);
    }
    if (kept.length) lines.push(kept.join(" "));
  }
  return { text: lines.join("\n").trim(), dropped: [...new Set(dropped)] };
}
