import "server-only";
/**
 * Тестовое письмо магазина. Проверяет ровно ту цепочку, что будет работать в автоматизациях:
 * ключ Brevo → настройки ЭТОГО магазина → его шаблон → отправка. Поэтому успешный тест
 * означает, что и рассылка уйдёт с правильным отправителем и брендингом.
 *
 * Переменные подставляются демонстрационные, но с теми же именами, что в автоматизациях —
 * так владелец сразу видит в письме, всё ли размечено в шаблоне Brevo.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import type { EmailProvider } from "./types";
import { normalizeEmail } from "./brevo";
import { resolveSiteEmailConfig, resolveSiteTemplateId, recordEmailTestResult } from "./settings";

/** Демо-значения переменных шаблона — совпадают по именам с переменными автоматизаций. */
function demoParams(siteName: string): Record<string, string> {
  return {
    order_number: "#10001",
    sender_name: "Иван Заказчик",
    recipient_name: "Мария Получатель",
    sender_phone: "+13105550001",
    recipient_phone: "+13105550002",
    delivery_address: "1234 Sunset Blvd, Los Angeles 90026",
    delivery_date: "July 30, 2026",
    delivery_time: "11:00 - 15:00",
    tracking_url: "https://example.com/tracking/demo",
    store_name: siteName,
    store_phone: "+13105550000",
    order_total: "$189.50",
    card_message: "С днём рождения!",
    delivery_instructions: "Оставить у консьержа",
    review_url: "https://example.com/review/demo",
  };
}

export type TestSendResult = { ok: true; providerMessageId: string | null } | { ok: false; code: string; safeError: string };

export async function sendSiteTestEmail(
  prisma: PrismaClient,
  provider: EmailProvider,
  args: { siteId: string; to: string; triggerType?: string }
): Promise<TestSendResult> {
  const to = normalizeEmail(args.to);
  if (!to) {
    const r = { ok: false as const, code: "invalid_recipient_email", safeError: "Укажите корректный адрес для теста." };
    await recordEmailTestResult(prisma, args.siteId, { ok: false, safeError: r.safeError });
    return r;
  }

  const cfg = await resolveSiteEmailConfig(prisma, args.siteId);
  if (!cfg.ok) {
    await recordEmailTestResult(prisma, args.siteId, { ok: false, safeError: cfg.safeError });
    return { ok: false, code: cfg.skip, safeError: cfg.safeError };
  }

  // Шаблон: указанное событие, иначе любой настроенный у ЭТОГО магазина (чужие не подходят).
  let templateId: number | null = null;
  if (args.triggerType) {
    const t = await resolveSiteTemplateId(prisma, args.siteId, args.triggerType);
    if (!t.ok) {
      await recordEmailTestResult(prisma, args.siteId, { ok: false, safeError: t.safeError });
      return { ok: false, code: t.skip, safeError: t.safeError };
    }
    templateId = t.templateId;
  } else {
    const any = await prisma.siteEmailTemplate.findFirst({
      where: { siteId: args.siteId },
      orderBy: { triggerType: "asc" },
      select: { brevoTemplateId: true },
    });
    if (!any) {
      const safeError = "У магазина не задан ни один Brevo Template ID.";
      await recordEmailTestResult(prisma, args.siteId, { ok: false, safeError });
      return { ok: false, code: "site_template_missing", safeError };
    }
    templateId = any.brevoTemplateId;
  }

  const res = await provider.sendTemplate({
    to,
    brevoTemplateId: templateId,
    params: demoParams(cfg.config.siteName),
    sender: {
      email: cfg.config.senderEmail,
      name: cfg.config.senderName,
      brevoSenderId: cfg.config.brevoSenderId,
    },
    replyTo: cfg.config.replyTo,
  });

  await recordEmailTestResult(prisma, args.siteId, { ok: res.ok, safeError: res.ok ? undefined : res.safeError });
  return res.ok
    ? { ok: true, providerMessageId: res.providerMessageId }
    : { ok: false, code: res.code, safeError: res.safeError };
}
