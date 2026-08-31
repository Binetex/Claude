import "server-only";
/**
 * Настройки модуля отзывов на магазин: тексты сообщений клиенту и сроки воронки.
 *
 * Строки может не быть — это «работаем по умолчанию», а не поломка: тот же принцип, что у
 * настроек печати. Поэтому пустое поле означает «взять текст по умолчанию», а не «отправить
 * пустое сообщение».
 */
import { prisma } from "@/lib/db";
import { SMS_MAX_LENGTH } from "@/integrations/quo/send";
import { SMS_VARIABLES } from "@/modules/messaging/variables";
import { extractVariables } from "@/modules/messaging/template";
import { DEFAULT_ASK_SMS, DEFAULT_REMINDER_SMS } from "./sendLink";
import { DEFAULT_REVIEW_SETTINGS } from "./requests";

export type ReviewSettingsInput = {
  askSmsTemplate: string;
  askBrevoTemplateId: string;
  reminderSmsTemplate: string;
  reminderBrevoTemplateId: string;
  promiseWaitDays: string;
  maxCallAttempts: string;
  callRetryDays: string;
};

export type SaveSettingsResult = { ok: true; warning?: string } | { ok: false; error: string };

const KNOWN_VARS = new Set(SMS_VARIABLES.map((v) => v.key));

/** Числовое поле с границами. Пустое — вернуть значение по умолчанию, а не ноль. */
function num(raw: string, fallback: number, min: number, max: number, label: string): number | string {
  const value = raw.trim();
  if (!value) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) return `${label}: нужно целое число от ${min} до ${max}.`;
  return n;
}

/**
 * Проверка текста сообщения.
 *
 * Неизвестная переменная — ошибка, а не мелочь: рендер молча заменяет её пустой строкой, и
 * клиент получит фразу с дырой. Кириллица — предупреждение, а не запрет: правило «с клиентом
 * по-английски» принадлежит владельцу, и запрещать ему собственный ввод мы не станем — но
 * сказать обязаны, потому что заметить это можно только по молчанию покупателей.
 */
function checkTemplate(text: string, label: string): { error?: string; warning?: string } {
  const value = text.trim();
  if (!value) return {};
  if (value.length > SMS_MAX_LENGTH) return { error: `${label}: слишком длинный текст.` };

  const unknown = extractVariables(value).filter((v) => !KNOWN_VARS.has(v));
  if (unknown.length > 0) {
    return { error: `${label}: переменных ${unknown.map((u) => `{{${u}}}`).join(", ")} не существует — они подставятся пустотой.` };
  }
  if (!value.includes("{{review_url}}")) {
    return { error: `${label}: без {{review_url}} сообщение бессмысленно — клиенту некуда идти.` };
  }
  if (/[а-яА-ЯёЁ]/.test(value)) {
    return { warning: `${label}: в тексте есть кириллица, а покупатели англоязычные.` };
  }
  return {};
}

export async function saveReviewSettings(siteId: string, input: ReviewSettingsInput): Promise<SaveSettingsResult> {
  const ask = checkTemplate(input.askSmsTemplate, "Просьба об отзыве");
  if (ask.error) return { ok: false, error: ask.error };
  const reminder = checkTemplate(input.reminderSmsTemplate, "Напоминание");
  if (reminder.error) return { ok: false, error: reminder.error };

  const numbers = {
    promiseWaitDays: num(input.promiseWaitDays, DEFAULT_REVIEW_SETTINGS.promiseWaitDays, 1, 90, "Сколько ждать обещанный отзыв"),
    maxCallAttempts: num(input.maxCallAttempts, DEFAULT_REVIEW_SETTINGS.maxCallAttempts, 1, 10, "Попыток звонка"),
    callRetryDays: num(input.callRetryDays, DEFAULT_REVIEW_SETTINGS.callRetryDays, 1, 30, "Через сколько дней перезванивать"),
  };
  for (const value of Object.values(numbers)) {
    if (typeof value === "string") return { ok: false, error: value };
  }

  const templateId = (raw: string): number | null => {
    const value = raw.trim();
    return value ? Number(value) : null;
  };
  for (const raw of [input.askBrevoTemplateId, input.reminderBrevoTemplateId]) {
    const id = templateId(raw);
    if (id !== null && (!Number.isInteger(id) || id <= 0)) {
      return { ok: false, error: "Brevo Template ID — это положительное число из кабинета Brevo." };
    }
  }

  const data = {
    askSmsTemplate: input.askSmsTemplate.trim() || null,
    reminderSmsTemplate: input.reminderSmsTemplate.trim() || null,
    askBrevoTemplateId: templateId(input.askBrevoTemplateId),
    reminderBrevoTemplateId: templateId(input.reminderBrevoTemplateId),
    promiseWaitDays: numbers.promiseWaitDays as number,
    maxCallAttempts: numbers.maxCallAttempts as number,
    callRetryDays: numbers.callRetryDays as number,
  };

  await prisma.siteReviewSettings.upsert({ where: { siteId }, update: data, create: { siteId, ...data } });

  return { ok: true, warning: ask.warning ?? reminder.warning };
}

export type SiteReviewSettingsView = {
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

export const DEFAULT_TEXTS = { ask: DEFAULT_ASK_SMS, reminder: DEFAULT_REMINDER_SMS };

export async function listReviewSettings(): Promise<SiteReviewSettingsView[]> {
  const sites = await prisma.site.findMany({
    select: { id: true, name: true, reviewSettings: true },
    orderBy: { name: "asc" },
  });
  return sites.map((s) => ({
    siteId: s.id,
    siteName: s.name,
    // Пустая строка означает «работает текст по умолчанию» — он показан в поле подсказкой.
    askSmsTemplate: s.reviewSettings?.askSmsTemplate ?? "",
    reminderSmsTemplate: s.reviewSettings?.reminderSmsTemplate ?? "",
    askBrevoTemplateId: s.reviewSettings?.askBrevoTemplateId?.toString() ?? "",
    reminderBrevoTemplateId: s.reviewSettings?.reminderBrevoTemplateId?.toString() ?? "",
    promiseWaitDays: String(s.reviewSettings?.promiseWaitDays ?? DEFAULT_REVIEW_SETTINGS.promiseWaitDays),
    maxCallAttempts: String(s.reviewSettings?.maxCallAttempts ?? DEFAULT_REVIEW_SETTINGS.maxCallAttempts),
    callRetryDays: String(s.reviewSettings?.callRetryDays ?? DEFAULT_REVIEW_SETTINGS.callRetryDays),
  }));
}
