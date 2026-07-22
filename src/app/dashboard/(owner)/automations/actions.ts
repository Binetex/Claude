"use server";
import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/rbac";
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

const AUDIENCES = new Set(["CUSTOMER", "RECIPIENT", "BOTH"]);
const DELAY_UNITS = new Set(["IMMEDIATE", "MINUTE", "HOUR", "DAY", "WEEK", "MONTH"]);
const CHANNELS = new Set(["SMS"]); // расширяется вместе с AutomationChannel + ChannelSender

export type AutomationInput = {
  siteId: string;
  name: string;
  active: boolean;
  channel: "SMS";
  triggerType: string;
  audience: "CUSTOMER" | "RECIPIENT" | "BOTH";
  delayAmount: number;
  delayUnit: "IMMEDIATE" | "MINUTE" | "HOUR" | "DAY" | "WEEK" | "MONTH";
  template: string;
  conditions: SmsConditions;
};

export type ActionResult = { ok?: true; id?: string; error?: string; warning?: string };

function validate(input: AutomationInput): string | null {
  if (!input.siteId) return "Выберите магазин.";
  if (!input.name?.trim()) return "Укажите название.";
  if (!CHANNELS.has(input.channel)) return "Неизвестный канал.";
  if (!isSupportedTrigger(input.triggerType)) return "Неизвестный триггер.";
  if (!AUDIENCES.has(input.audience)) return "Некорректная аудитория.";
  if (!DELAY_UNITS.has(input.delayUnit)) return "Некорректная единица задержки.";
  if (!Number.isInteger(input.delayAmount) || input.delayAmount < 0) return "Задержка должна быть неотрицательным целым числом.";
  if (!input.template?.trim()) return "Введите текст сообщения.";
  if (input.template.length > 1600) return "Слишком длинный шаблон (макс. 1600 символов).";
  return null;
}

/** Мягкое предупреждение (не блокирует сохранение): review_url используется, но не задан у магазина. */
async function reviewUrlWarning(siteId: string, template: string): Promise<string | undefined> {
  if (!/\{\{\s*review_url\s*\}\}/.test(template)) return undefined;
  const site = await prisma.site.findUnique({ where: { id: siteId }, select: { reviewUrl: true } });
  if (!site?.reviewUrl) return "Шаблон использует {{review_url}}, но у магазина не задана ссылка на отзыв — такие сообщения не будут отправлены, пока вы её не заполните.";
  return undefined;
}

function normalizeConditions(c: SmsConditions): SmsConditions {
  // Храним только заданные флаги; excludeCancelledRefunded по умолчанию ВКЛ на уровне движка.
  const out: SmsConditions = {};
  if (c.requirePaid) out.requirePaid = true;
  if (c.excludeCancelledRefunded === false) out.excludeCancelledRefunded = false;
  if (c.deliveryToday) out.deliveryToday = true;
  if (c.apartmentPresent) out.apartmentPresent = true;
  return out;
}

export async function createAutomation(input: AutomationInput): Promise<ActionResult> {
  await requireRole("OWNER");
  const err = validate(input);
  if (err) return { error: err };
  const site = await prisma.site.findUnique({ where: { id: input.siteId }, select: { id: true } });
  if (!site) return { error: "Магазин не найден." };

  const created = await prisma.automation.create({
    data: {
      siteId: input.siteId,
      name: input.name.trim(),
      active: !!input.active,
      channel: input.channel,
      triggerType: input.triggerType,
      audience: input.audience,
      delayAmount: input.delayAmount,
      delayUnit: input.delayUnit,
      template: input.template,
      conditionsJson: normalizeConditions(input.conditions),
    },
    select: { id: true },
  });
  revalidatePath("/dashboard/automations");
  return { ok: true, id: created.id, warning: await reviewUrlWarning(input.siteId, input.template) };
}

export async function updateAutomation(id: string, input: AutomationInput): Promise<ActionResult> {
  await requireRole("OWNER");
  const err = validate(input);
  if (err) return { error: err };
  const existing = await prisma.automation.findUnique({ where: { id }, select: { id: true, deletedAt: true } });
  if (!existing || existing.deletedAt) return { error: "Автоматизация не найдена." };

  await prisma.automation.update({
    where: { id },
    data: {
      // siteId менять не даём — история job'ов привязана к магазину.
      name: input.name.trim(),
      active: !!input.active,
      channel: input.channel,
      triggerType: input.triggerType,
      audience: input.audience,
      delayAmount: input.delayAmount,
      delayUnit: input.delayUnit,
      template: input.template,
      conditionsJson: normalizeConditions(input.conditions),
    },
  });
  revalidatePath("/dashboard/automations");
  revalidatePath(`/dashboard/automations/${id}`);
  return { ok: true, id, warning: await reviewUrlWarning(input.siteId, input.template) };
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
  const src = await prisma.automation.findUnique({ where: { id } });
  if (!src || src.deletedAt) return { error: "Автоматизация не найдена." };
  const copy = await prisma.automation.create({
    data: {
      siteId: src.siteId,
      name: `${src.name} (копия)`,
      active: false, // копия всегда выключена
      channel: src.channel,
      triggerType: src.triggerType,
      audience: src.audience,
      delayAmount: src.delayAmount,
      delayUnit: src.delayUnit,
      template: src.template,
      conditionsJson: src.conditionsJson ?? undefined,
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

export async function saveSiteReviewUrl(siteId: string, reviewUrl: string): Promise<ActionResult> {
  await requireRole("OWNER");
  const value = reviewUrl.trim();
  if (value && !/^https?:\/\//i.test(value)) return { error: "Ссылка должна начинаться с http:// или https://" };
  const site = await prisma.site.findUnique({ where: { id: siteId }, select: { id: true } });
  if (!site) return { error: "Магазин не найден." };
  await prisma.site.update({ where: { id: siteId }, data: { reviewUrl: value || null } });
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
