/**
 * Заготовки магазина: включена ли и каким текстом. Чистый модуль — читают и сервер, и форма.
 *
 * Хранится JSON'ом на магазине, но наружу отдаётся уже разобранным: остальному коду не должно
 * быть дела до того, что где-то там `Json?`.
 */
import { INTENTS, type IntentDef, type IntentKey } from "./intents";

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
export function templateApplies(def: IntentDef, setting: TemplateSetting, vars: Record<string, string>): boolean {
  if (!setting.enabled || !setting.text.trim()) return false;
  return def.requires.every((key) => !!vars[key]?.trim());
}
