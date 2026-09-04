"use server";
import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/rbac";
import { clampWait, findChainCycle } from "@/modules/automations/chain";
import { WAIT_FIRST_MIN } from "@/modules/automations/replyWait";

/** Запасное значение, если поле срока пришло пустым при непустой ссылке. */
import { prisma } from "@/lib/db";
import { featureFlags } from "@/lib/featureFlags";
import { getQuoConfig } from "@/integrations/quo/config";
import { createQuoClient } from "@/integrations/quo/client";
import { toE164 } from "@/lib/phone";
import { isSupportedTrigger } from "@/modules/automations/triggers";
import { buildAutomationPreview } from "@/modules/automations/preview";
import { buildTestMessage, sendTestSmsViaClient } from "@/modules/automations/testSend";
import { setAutomationsGloballyDisabled } from "@/modules/automations/settings";
import type { SmsConditions } from "@/modules/automations/conditions";
import { resolveSiteEmailConfig, resolveEmailTemplateForAutomation } from "@/integrations/email/settings";

const AUDIENCES = new Set(["CUSTOMER", "RECIPIENT", "BOTH"]);
const DELAY_UNITS = new Set(["IMMEDIATE", "MINUTE", "HOUR", "DAY", "WEEK", "MONTH"]);

export type AutomationInput = {
  /** Магазины правила (M:N). Один шаблон/триггер/условия — на все выбранные Site. */
  siteIds: string[];
  name: string;
  active: boolean;
  /** Каналы доставки. Хотя бы один обязателен; fallback имеет смысл только при smsEnabled. */
  smsEnabled: boolean;
  emailEnabled: boolean;
  emailFallbackEnabled: boolean;
  /** Override общего шаблона магазина именно для этого правила (Stage 2.1). null = не задан. */
  brevoTemplateId: number | null;
  triggerType: string;
  audience: "CUSTOMER" | "RECIPIENT" | "BOTH";
  delayAmount: number;
  delayUnit: "IMMEDIATE" | "MINUTE" | "HOUR" | "DAY" | "WEEK" | "MONTH";
  template: string;
  conditions: SmsConditions;
  /** «Если не ответят — запустить это правило». null = цепочка на этом правиле заканчивается. */
  noReplyNextAutomationId?: string | null;
  /** Сколько ждать ответа на сообщение ЭТОГО правила, минут. null = срок магазина. */
  noReplyAfterMin?: number | null;
};

export type ActionResult = { ok?: true; id?: string; error?: string; warning?: string };

function validate(input: AutomationInput): string | null {
  if (!Array.isArray(input.siteIds) || input.siteIds.length === 0) return "Выберите хотя бы один магазин.";
  if (!input.name?.trim()) return "Укажите название.";
  if (!input.smsEnabled && !input.emailEnabled) return "Выберите хотя бы один канал: SMS или Email.";
  if (input.emailFallbackEnabled && !input.smsEnabled) return "«Email, если SMS недоступно» имеет смысл только при включённом SMS.";
  if (input.brevoTemplateId != null && (!Number.isInteger(input.brevoTemplateId) || input.brevoTemplateId <= 0)) {
    return "Template ID правила должен быть целым положительным числом.";
  }
  if (!isSupportedTrigger(input.triggerType)) return "Неизвестный триггер.";
  if (!AUDIENCES.has(input.audience)) return "Некорректная аудитория.";
  if (!DELAY_UNITS.has(input.delayUnit)) return "Некорректная единица задержки.";
  if (!Number.isInteger(input.delayAmount) || input.delayAmount < 0) return "Задержка должна быть неотрицательным целым числом.";
  // SMS-текст (template) обязателен только когда SMS реально включён — Email-only правило может
  // не иметь inline-текста (у Email — Brevo-шаблон per Site, настраивается в /dashboard/sites).
  if (input.smsEnabled) {
    if (!input.template?.trim()) return "Введите текст SMS.";
    if (input.template.length > 1600) return "Слишком длинный шаблон (макс. 1600 символов).";
  }
  return null;
}

/** Дедуп + проверка существования выбранных магазинов. */
async function resolveSiteIds(siteIds: string[]): Promise<{ ids: string[] } | { error: string }> {
  const unique = [...new Set(siteIds.filter(Boolean))];
  const found = await prisma.site.findMany({ where: { id: { in: unique } }, select: { id: true } });
  if (found.length !== unique.length) return { error: "Один из выбранных магазинов не найден." };
  return { ids: unique };
}

/**
 * Мягкое предупреждение (не блокирует сохранение): шаблон использует {{review_url}}, а взять
 * ссылку неоткуда. Смотрим и на точки раздела «Отзывы», и на общую ссылку магазина: переменная
 * берёт ближайшую точку, а общая ссылка осталась запасом.
 */
async function reviewUrlWarning(siteIds: string[], template: string): Promise<string | undefined> {
  if (!/\{\{\s*review_url\s*\}\}/.test(template)) return undefined;
  const sites = await prisma.site.findMany({
    where: { id: { in: siteIds } },
    select: { name: true, reviewUrl: true, googleLocations: { where: { isActive: true }, select: { id: true } } },
  });
  const missing = sites.filter((s) => !s.reviewUrl && s.googleLocations.length === 0).map((s) => s.name);
  if (missing.length === 0) return undefined;
  return `Шаблон использует {{review_url}}, но у магазинов ${missing.join(", ")} нет ни одной точки в разделе «Отзывы» — такие сообщения не уйдут, пока точку не заведёте.`;
}

function normalizeConditions(c: SmsConditions): SmsConditions {
  // Храним только заданные флаги; excludeCancelledRefunded по умолчанию ВКЛ на уровне движка.
  const out: SmsConditions = {};
  if (c.requirePaid) out.requirePaid = true;
  if (c.excludeCancelledRefunded === false) out.excludeCancelledRefunded = false;
  if (c.apartmentPresent) out.apartmentPresent = true;
  return out;
}

/**
 * Проверяет ссылку «если не ответят — запустить это правило».
 *
 * Три отказа, и каждый из них — про живого человека на том конце: без SMS ответ узнать неоткуда
 * (входящие приходят на номер), правило, запускающее само себя, и кольцо дальше по цепочке
 * означают бесконечную рассылку. Потолок сообщений на заказ в замке цепочки — последний рубеж,
 * а не оправдание пускать кольцо в настройку.
 */
async function validateNoReplyLink(input: AutomationInput, selfId: string | null): Promise<string | null> {
  const nextId = input.noReplyNextAutomationId ?? null;
  if (!nextId) return null;
  if (!input.smsEnabled) return "Ожидание ответа работает только для SMS: ответ мы узнаём по входящим сообщениям и звонкам с номера.";
  if (selfId && nextId === selfId) return "Правило не может запускать само себя.";

  const rows = await prisma.automation.findMany({
    where: { deletedAt: null },
    select: { id: true, name: true, noReplyNextAutomationId: true, sites: { select: { siteId: true } } },
  });
  const next = rows.find((r) => r.id === nextId);
  if (!next) return "Следующее правило не найдено — возможно, его удалили.";

  // Шаг запускается в магазине заказа, поэтому у правил обязан быть общий магазин: иначе форма
  // сохранит связь, а цепочка молча оборвётся на первом же шаге.
  const nextSites = new Set(next.sites.map((x) => x.siteId));
  if (input.siteIds.length && !input.siteIds.some((id) => nextSites.has(id))) {
    return `Правило «${next.name}» не подключено ни к одному из выбранных магазинов — цепочка до него не дойдёт.`;
  }

  const nextById = new Map(rows.map((r) => [r.id, r.noReplyNextAutomationId]));
  const nameById = new Map(rows.map((r) => [r.id, r.name]));
  const cycle = findChainCycle(nextById, selfId ?? "__new__", nextId);
  if (cycle) {
    const names = cycle.map((id) => nameById.get(id) ?? (input.name.trim() || "это правило")).join(" → ");
    return `Цепочка замыкается в кольцо: ${names}. Человек получал бы сообщения без конца.`;
  }
  return null;
}

export async function createAutomation(input: AutomationInput): Promise<ActionResult> {
  await requireRole("OWNER");
  const err = validate(input);
  if (err) return { error: err };
  const linkErr = await validateNoReplyLink(input, null);
  if (linkErr) return { error: linkErr };
  const resolved = await resolveSiteIds(input.siteIds);
  if ("error" in resolved) return { error: resolved.error };

  const created = await prisma.automation.create({
    data: {
      sites: { create: resolved.ids.map((siteId) => ({ siteId })) },
      name: input.name.trim(),
      active: !!input.active,
      smsEnabled: input.smsEnabled,
      emailEnabled: input.emailEnabled,
      emailFallbackEnabled: input.smsEnabled && input.emailFallbackEnabled,
      brevoTemplateId: input.brevoTemplateId,
      triggerType: input.triggerType,
      audience: input.audience,
      delayAmount: input.delayAmount,
      delayUnit: input.delayUnit,
      template: input.template,
      conditionsJson: normalizeConditions(input.conditions),
      noReplyNextAutomationId: input.noReplyNextAutomationId ?? null,
      // Срок режем на сервере: форму можно обойти, а сломанная пауза видна уже по факту.
      noReplyAfterMin: input.noReplyNextAutomationId && input.noReplyAfterMin != null ? clampWait(input.noReplyAfterMin, WAIT_FIRST_MIN) : null,
    },
    select: { id: true },
  });
  revalidatePath("/dashboard/automations");
  return { ok: true, id: created.id, warning: await reviewUrlWarning(resolved.ids, input.template) };
}

export async function updateAutomation(id: string, input: AutomationInput): Promise<ActionResult> {
  await requireRole("OWNER");
  const err = validate(input);
  if (err) return { error: err };
  const existing = await prisma.automation.findUnique({
    where: { id },
    select: { id: true, deletedAt: true, sites: { select: { siteId: true } } },
  });
  if (!existing || existing.deletedAt) return { error: "Автоматизация не найдена." };
  const linkErr = await validateNoReplyLink(input, id);
  if (linkErr) return { error: linkErr };
  const resolved = await resolveSiteIds(input.siteIds);
  if ("error" in resolved) return { error: resolved.error };

  // Диффим набор магазинов: существующие связи не трогаем (сохраняем createdAt). Отвязка магазина
  // не удаляет историю — job'ы остаются, они привязаны к automationId+orderId.
  const current = new Set(existing.sites.map((s) => s.siteId));
  const next = new Set(resolved.ids);
  const toAdd = resolved.ids.filter((s) => !current.has(s));
  const toRemove = [...current].filter((s) => !next.has(s));

  await prisma.automation.update({
    where: { id },
    data: {
      sites: {
        deleteMany: toRemove.length ? { siteId: { in: toRemove } } : undefined,
        create: toAdd.map((siteId) => ({ siteId })),
      },
      name: input.name.trim(),
      active: !!input.active,
      smsEnabled: input.smsEnabled,
      emailEnabled: input.emailEnabled,
      emailFallbackEnabled: input.smsEnabled && input.emailFallbackEnabled,
      brevoTemplateId: input.brevoTemplateId,
      triggerType: input.triggerType,
      audience: input.audience,
      delayAmount: input.delayAmount,
      delayUnit: input.delayUnit,
      template: input.template,
      conditionsJson: normalizeConditions(input.conditions),
      noReplyNextAutomationId: input.noReplyNextAutomationId ?? null,
      // Срок режем на сервере: форму можно обойти, а сломанная пауза видна уже по факту.
      noReplyAfterMin: input.noReplyNextAutomationId && input.noReplyAfterMin != null ? clampWait(input.noReplyAfterMin, WAIT_FIRST_MIN) : null,
    },
  });
  revalidatePath("/dashboard/automations");
  revalidatePath(`/dashboard/automations/${id}`);
  return { ok: true, id, warning: await reviewUrlWarning(resolved.ids, input.template) };
}

export async function toggleAutomation(id: string, active: boolean): Promise<ActionResult> {
  await requireRole("OWNER");
  const existing = await prisma.automation.findUnique({ where: { id }, select: { deletedAt: true } });
  if (!existing || existing.deletedAt) return { error: "Автоматизация не найдена." };
  await prisma.automation.update({ where: { id }, data: { active: !!active } });
  revalidatePath("/dashboard/automations");
  return { ok: true };
}

export async function duplicateAutomation(id: string): Promise<ActionResult> {
  await requireRole("OWNER");
  const src = await prisma.automation.findUnique({ where: { id }, include: { sites: { select: { siteId: true } } } });
  if (!src || src.deletedAt) return { error: "Автоматизация не найдена." };
  const copy = await prisma.automation.create({
    data: {
      sites: { create: src.sites.map((s) => ({ siteId: s.siteId })) },
      name: `${src.name} (копия)`,
      active: false, // копия всегда выключена
      smsEnabled: src.smsEnabled,
      emailEnabled: src.emailEnabled,
      emailFallbackEnabled: src.emailFallbackEnabled,
      brevoTemplateId: src.brevoTemplateId,
      triggerType: src.triggerType,
      audience: src.audience,
      delayAmount: src.delayAmount,
      delayUnit: src.delayUnit,
      template: src.template,
      conditionsJson: src.conditionsJson ?? undefined,
      noReplyNextAutomationId: src.noReplyNextAutomationId,
      noReplyAfterMin: src.noReplyAfterMin,
    },
    select: { id: true },
  });
  revalidatePath("/dashboard/automations");
  return { ok: true, id: copy.id };
}

/** Удаление: hard-delete ТОЛЬКО если истории нет; иначе soft-delete (job'ы сохраняются). */
export async function deleteAutomation(id: string): Promise<ActionResult> {
  await requireRole("OWNER");
  const existing = await prisma.automation.findUnique({ where: { id }, select: { id: true } });
  if (!existing) return { error: "Автоматизация не найдена." };
  const jobs = await prisma.automationJob.count({ where: { automationId: id } });
  if (jobs > 0) {
    await prisma.automation.update({ where: { id }, data: { deletedAt: new Date(), active: false } });
  } else {
    await prisma.automation.delete({ where: { id } });
  }
  revalidatePath("/dashboard/automations");
  return { ok: true };
}

export type PreviewActionResult =
  | { ok: false; error: string }
  | { ok: true; orderNumber: string; text: string; missing: string[]; recipients: string[]; skipped: string[] };

export async function previewAutomation(orderId: string, template: string, audience: "CUSTOMER" | "RECIPIENT" | "BOTH"): Promise<PreviewActionResult> {
  await requireRole("OWNER");
  if (!orderId) return { ok: false, error: "Выберите заказ для preview." };
  const res = await buildAutomationPreview(prisma, { orderId, template, audience });
  if (!res.ok) return { ok: false, error: res.error === "order_not_found" ? "Заказ не найден." : res.error };
  return {
    ok: true,
    orderNumber: res.orderNumber,
    text: res.text,
    missing: res.missing,
    recipients: res.recipients.map((r) => `${r.recipientType === "CUSTOMER" ? "Заказчик" : "Получатель"}: ${r.phoneNormalized}`),
    skipped: res.skipped.map((s) => `${s.recipientType === "CUSTOMER" ? "Заказчик" : "Получатель"}: ${s.reason}`),
  };
}

export type SiteEmailTemplateStatus =
  | { ready: true; templateId: number; source: "automation" | "site" }
  | { ready: false; reason: string };

/**
 * Готов ли выбранный магазин слать Email для ЭТОГО события С УЧЁТОМ возможного override
 * шаблона у самого правила (Stage 2.1) — форма показывает статус вместо дублирования настроек
 * отправителя/домена (они на /dashboard/sites) И вместо дублирования логики резолва шаблона
 * (resolveEmailTemplateForAutomation — тот же код, что реально используется при отправке).
 */
export async function checkSiteEmailTemplate(siteId: string, triggerType: string, ruleTemplateId: number | null = null): Promise<SiteEmailTemplateStatus> {
  await requireRole("OWNER");
  if (!siteId || !isSupportedTrigger(triggerType)) return { ready: false, reason: "site_or_trigger_missing" };
  const cfg = await resolveSiteEmailConfig(prisma, siteId);
  if (!cfg.ok) return { ready: false, reason: cfg.skip };
  const tpl = await resolveEmailTemplateForAutomation(prisma, { siteId, triggerType, automationTemplateId: ruleTemplateId });
  if (!tpl.ok) return { ready: false, reason: tpl.skip };
  return { ready: true, templateId: tpl.templateId, source: tpl.source };
}

/**
 * Тестовая отправка. НЕ создаёт AutomationJob, НЕ пишет OrderCommunication и НЕ меняет заказ.
 * Отправляет через QUO-номер выбранного Site на введённый вручную номер. Переменные — примерные,
 * поверх подставляются реальные store_name/store_phone/review_url магазина.
 */
export async function sendTestSms(siteId: string, toPhoneRaw: string, template: string): Promise<ActionResult> {
  await requireRole("OWNER");
  if (!template?.trim()) return { error: "Введите текст сообщения." };
  const to = toE164(toPhoneRaw);
  if (!to) return { error: "Некорректный номер получателя теста." };

  const site = await prisma.site.findUnique({
    where: { id: siteId },
    select: { name: true, quoPhoneNumberId: true, quoPhoneNumber: true, quoEnabled: true, reviewUrl: true },
  });
  if (!site) return { error: "Магазин не найден." };
  if (!site.quoEnabled) return { error: "QUO отключён для этого магазина." };
  if (!site.quoPhoneNumberId) return { error: "У магазина не настроен номер QUO." };

  const cfg = getQuoConfig();
  const client = cfg && featureFlags.quo ? createQuoClient({ ...cfg, maxRetries: 0 }) : null;
  if (!client) return { error: "Интеграция QUO не настроена." };

  // buildTestMessage/sendTestSmsViaClient не пишут в БД: job/OrderCommunication НЕ создаются.
  const body = buildTestMessage(template, { name: site.name, quoPhoneNumber: site.quoPhoneNumber, reviewUrl: site.reviewUrl });
  try {
    await sendTestSmsViaClient(client, { fromId: site.quoPhoneNumberId, to, body });
    return { ok: true };
  } catch {
    return { error: "QUO отклонил тестовую отправку." };
  }
}
/**
 * Время ежедневных триггеров магазина ("HH:mm" локального времени). Используется триггером
 * «Доставка сегодня»: задача публикуется отложенно на это время локального дня доставки.
 * Изменение действует на заказы, запланированные ПОСЛЕ сохранения — уже поставленные задачи
 * останутся на прежнем времени (перепланирование произойдёт при следующем изменении заказа).
 */
export async function saveSiteAutomationDailyTime(siteId: string, value: string): Promise<ActionResult> {
  await requireRole("OWNER");
  const v = value.trim();
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) return { error: "Время в формате ЧЧ:ММ, например 09:00." };
  const site = await prisma.site.findUnique({ where: { id: siteId }, select: { id: true } });
  if (!site) return { error: "Магазин не найден." };
  await prisma.site.update({ where: { id: siteId }, data: { automationDailyLocalTime: v } });
  revalidatePath("/dashboard/automations");
  return { ok: true };
}

/** Глобальный «рубильник»: при disableAll=true движок не создаёт и не отправляет job'ы. */
export async function setKillSwitch(disableAll: boolean): Promise<ActionResult> {
  const user = await requireRole("OWNER");
  await setAutomationsGloballyDisabled(prisma, !!disableAll, user.id);
  revalidatePath("/dashboard/automations");
  return { ok: true };
}
