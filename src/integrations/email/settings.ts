import "server-only";
/**
 * Email-настройки магазина: чтение, запись и ГЕЙТ отправки.
 *
 * Ключевая гарантия: письмо магазина уходит только с его собственным отправителем и его
 * собственным шаблоном. Настройки всегда ищутся по siteId, никаких значений «по умолчанию»
 * от другого магазина нет — если у магазина не заполнено, отправка не состоится.
 *
 * Незавершённая настройка — это не ошибка приложения: resolveSiteEmailConfig возвращает
 * причину (`site_email_disabled`, `site_email_not_configured`, …), а вызывающий код пропускает
 * отправку с понятным статусом.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { isSupportedTrigger } from "@/modules/automations/triggers";
import { normalizeEmail } from "./brevo";
import { isBrevoConfiguredAnywhere } from "./accountKey";

export type SiteEmailConfig = {
  siteId: string;
  siteName: string;
  senderEmail: string;
  senderName: string | null;
  replyTo: string | null;
  brevoSenderId: string | null;
};

/**
 * Что отдаётся в UI. Секретов здесь нет по построению: общий API key живёт зашифрованным в БД
 * (приоритетнее) либо в env, а `brevoApiKeyConfigured` — это факт его наличия, не значение.
 */
export type SiteEmailSettingsView = {
  enabled: boolean;
  senderEmail: string | null;
  senderName: string | null;
  replyTo: string | null;
  brevoSenderId: string | null;
  domainVerified: boolean;
  lastTestAt: string | null;
  lastTestStatus: string | null;
  lastErrorSafe: string | null;
  /** triggerType → Brevo Template ID. */
  templates: Record<string, number>;
  brevoApiKeyConfigured: boolean;
};

/** Почему отправка невозможна. Значения попадают в историю отправок как есть. */
export type EmailConfigSkip =
  | "email_not_configured" // нет BREVO_API_KEY (общий на аккаунт)
  | "site_email_disabled" // магазин выключил Email
  | "site_email_not_configured" // нет отправителя
  | "site_domain_not_verified" // домен отправителя не подтверждён владельцем
  | "site_template_missing"; // для этого события у магазина нет шаблона

export type ResolveConfigResult =
  | { ok: true; config: SiteEmailConfig }
  | { ok: false; skip: EmailConfigSkip; safeError: string };

/**
 * Готов ли магазин отправлять письма. Порядок проверок — от общего к частному, чтобы причина
 * в истории была самой информативной.
 */
export async function resolveSiteEmailConfig(prisma: PrismaClient, siteId: string): Promise<ResolveConfigResult> {
  if (!(await isBrevoConfiguredAnywhere(prisma))) {
    return { ok: false, skip: "email_not_configured", safeError: "Brevo не настроен: нет API key (ни в БД, ни в BREVO_API_KEY)." };
  }

  const site = await prisma.site.findUnique({
    where: { id: siteId },
    select: { id: true, name: true, emailSettings: true },
  });
  if (!site) return { ok: false, skip: "site_email_not_configured", safeError: "Магазин не найден." };

  const s = site.emailSettings;
  if (!s || !s.enabled) {
    return { ok: false, skip: "site_email_disabled", safeError: `Email для «${site.name}» выключен.` };
  }

  const senderEmail = normalizeEmail(s.senderEmail);
  if (!senderEmail) {
    return { ok: false, skip: "site_email_not_configured", safeError: `У «${site.name}» не задан адрес отправителя.` };
  }
  if (!s.domainVerifiedAt) {
    return { ok: false, skip: "site_domain_not_verified", safeError: `Домен отправителя «${site.name}» не отмечен как подтверждённый.` };
  }

  return {
    ok: true,
    config: {
      siteId: site.id,
      siteName: site.name,
      senderEmail,
      senderName: s.senderName,
      replyTo: normalizeEmail(s.replyTo),
      brevoSenderId: s.brevoSenderId,
    },
  };
}

/** Brevo Template ID магазина для события. Отсутствие — причина пропуска, а не ошибка. */
export async function resolveSiteTemplateId(
  prisma: PrismaClient,
  siteId: string,
  triggerType: string
): Promise<{ ok: true; templateId: number } | { ok: false; skip: EmailConfigSkip; safeError: string }> {
  const row = await prisma.siteEmailTemplate.findUnique({
    where: { siteId_triggerType: { siteId, triggerType } },
    select: { brevoTemplateId: true },
  });
  if (!row) {
    return { ok: false, skip: "site_template_missing", safeError: `Нет Brevo-шаблона для события ${triggerType}.` };
  }
  return { ok: true, templateId: row.brevoTemplateId };
}

export type ResolveRuleTemplateResult =
  | { ok: true; templateId: number; source: "automation" | "site" }
  | { ok: false; skip: EmailConfigSkip; safeError: string };

/**
 * Template ID для КОНКРЕТНОГО правила (Stage 2.1). Override правила (Automation.brevoTemplateId)
 * приоритетнее общего шаблона магазина; если override не задан — as-is поведение Stage 2
 * (SiteEmailTemplate по siteId+triggerType). Используется и реальной отправкой
 * (channels/email.ts), и read-only подсказкой в форме правила — единая логика, один источник
 * истины для «какой шаблон реально уйдёт».
 */
export async function resolveEmailTemplateForAutomation(
  prisma: PrismaClient,
  args: { siteId: string; triggerType: string; automationTemplateId: number | null }
): Promise<ResolveRuleTemplateResult> {
  if (args.automationTemplateId != null) {
    return { ok: true, templateId: args.automationTemplateId, source: "automation" };
  }
  const site = await resolveSiteTemplateId(prisma, args.siteId, args.triggerType);
  if (!site.ok) return site;
  return { ok: true, templateId: site.templateId, source: "site" };
}

/**
 * Настройки всех магазинов сразу — страница «Сайты» рендерит их списком, а каждый лишний
 * round-trip к БД там заметен. Магазин без настроек — это выключенный Email, а не ошибка,
 * поэтому в результате есть запись для каждого запрошенного siteId.
 */
export async function loadSiteEmailSettingsViews(
  prisma: PrismaClient,
  siteIds: string[]
): Promise<Record<string, SiteEmailSettingsView>> {
  const [rows, templates, apiKeyConfigured] = await Promise.all([
    prisma.siteEmailSettings.findMany({ where: { siteId: { in: siteIds } } }),
    prisma.siteEmailTemplate.findMany({
      where: { siteId: { in: siteIds } },
      select: { siteId: true, triggerType: true, brevoTemplateId: true },
    }),
    isBrevoConfiguredAnywhere(prisma),
  ]);

  const bySite = new Map(rows.map((r) => [r.siteId, r]));

  const out: Record<string, SiteEmailSettingsView> = {};
  for (const siteId of siteIds) {
    const s = bySite.get(siteId);
    out[siteId] = {
      enabled: !!s?.enabled,
      senderEmail: s?.senderEmail ?? null,
      senderName: s?.senderName ?? null,
      replyTo: s?.replyTo ?? null,
      brevoSenderId: s?.brevoSenderId ?? null,
      domainVerified: !!s?.domainVerifiedAt,
      lastTestAt: s?.lastTestAt ? s.lastTestAt.toISOString() : null,
      lastTestStatus: s?.lastTestStatus ?? null,
      lastErrorSafe: s?.lastErrorSafe ?? null,
      templates: Object.fromEntries(
        templates.filter((t) => t.siteId === siteId).map((t) => [t.triggerType, t.brevoTemplateId])
      ),
      brevoApiKeyConfigured: apiKeyConfigured,
    };
  }
  return out;
}

export type SiteEmailSettingsInput = {
  enabled?: boolean;
  senderEmail?: string | null;
  senderName?: string | null;
  replyTo?: string | null;
  brevoSenderId?: string | null;
  domainVerified?: boolean;
};

/**
 * Сохранение настроек магазина. Включить Email нельзя, пока не заданы адрес отправителя и
 * отметка о подтверждённом домене — иначе правило «письмо только с подтверждённого домена»
 * обходилось бы одним чекбоксом.
 */
export async function saveSiteEmailSettings(
  prisma: PrismaClient,
  siteId: string,
  input: SiteEmailSettingsInput
): Promise<{ ok: true } | { error: string }> {
  const senderEmail = input.senderEmail === undefined ? undefined : normalizeEmail(input.senderEmail);
  if (input.senderEmail && !senderEmail) return { error: "Некорректный адрес отправителя." };
  if (input.replyTo && !normalizeEmail(input.replyTo)) return { error: "Некорректный Reply-To." };

  const existing = await prisma.siteEmailSettings.findUnique({ where: { siteId } });
  const nextSender = senderEmail ?? existing?.senderEmail ?? null;
  const nextVerified = input.domainVerified ?? !!existing?.domainVerifiedAt;

  if (input.enabled) {
    if (!nextSender) return { error: "Укажите адрес отправителя перед включением Email." };
    if (!nextVerified) return { error: "Отметьте домен как подтверждённый в Brevo перед включением Email." };
  }

  const data = {
    ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
    ...(senderEmail !== undefined ? { senderEmail } : {}),
    ...(input.senderName !== undefined ? { senderName: input.senderName?.trim() || null } : {}),
    ...(input.replyTo !== undefined ? { replyTo: input.replyTo ? normalizeEmail(input.replyTo) : null } : {}),
    ...(input.brevoSenderId !== undefined ? { brevoSenderId: input.brevoSenderId?.trim() || null } : {}),
    ...(input.domainVerified !== undefined ? { domainVerifiedAt: input.domainVerified ? (existing?.domainVerifiedAt ?? new Date()) : null } : {}),
  };

  await prisma.siteEmailSettings.upsert({
    where: { siteId },
    create: { siteId, ...data },
    update: data,
  });
  return { ok: true };
}

/** Сохранение/удаление Brevo Template ID для события. Пустое значение убирает шаблон. */
export async function saveSiteEmailTemplate(
  prisma: PrismaClient,
  siteId: string,
  triggerType: string,
  brevoTemplateId: number | null
): Promise<{ ok: true } | { error: string }> {
  if (brevoTemplateId === null) {
    await prisma.siteEmailTemplate.deleteMany({ where: { siteId, triggerType } });
    return { ok: true };
  }
  if (!Number.isInteger(brevoTemplateId) || brevoTemplateId <= 0) {
    return { error: "Template ID должен быть целым положительным числом." };
  }
  // Триггеры проверяем по тому же реестру, что и авто-SMS: иначе опечатка в событии создала бы
  // строку, которая никогда не совпадёт, а владелец считал бы письмо настроенным.
  if (!isSupportedTrigger(triggerType)) {
    return { error: `Неизвестное событие: ${triggerType}.` };
  }
  await prisma.siteEmailTemplate.upsert({
    where: { siteId_triggerType: { siteId, triggerType } },
    create: { siteId, triggerType, brevoTemplateId },
    update: { brevoTemplateId },
  });
  return { ok: true };
}

/** Запись результата тестовой отправки — по образцу QUO/Airwallex (статус + безопасная ошибка). */
export async function recordEmailTestResult(
  prisma: PrismaClient,
  siteId: string,
  result: { ok: boolean; safeError?: string }
): Promise<void> {
  await prisma.siteEmailSettings.upsert({
    where: { siteId },
    create: {
      siteId,
      lastTestAt: new Date(),
      lastTestStatus: result.ok ? "ok" : "error",
      lastErrorSafe: result.ok ? null : result.safeError ?? "Неизвестная ошибка.",
    },
    update: {
      lastTestAt: new Date(),
      lastTestStatus: result.ok ? "ok" : "error",
      lastErrorSafe: result.ok ? null : result.safeError ?? "Неизвестная ошибка.",
    },
  });
}
