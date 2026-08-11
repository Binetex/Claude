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
  args: {
    siteId: string;
    to: string;
    triggerType?: string;
    /**
     * Проверка отправителя в аккаунте Brevo. Необязательна (юнит-тесты обходятся без сети), но
     * когда передана — тест НЕ уходит с неподтверждённого адреса. Brevo такое письмо принимает и
     * молча блокирует, и «тест прошёл» становится враньём.
     */
    verifySender?: (senderEmail: string) => Promise<{ verified: boolean } | null>;
    /**
     * Проверка шаблона в аккаунте Brevo. Выключенный шаблон Brevo принимает и отклоняет уже на
     * отправке (`template is disabled`), поэтому «тест прошёл» без этой проверки может означать
     * «письмо никуда не ушло».
     */
    verifyTemplate?: (templateId: number) => Promise<{ exists: boolean; active: boolean; name: string | null } | null>;
  }
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

  if (args.verifySender) {
    const senderCheck = await args.verifySender(cfg.config.senderEmail);
    // null = спросить не удалось (сеть/права). Это не повод останавливать тест: отсутствие
    // ответа не означает, что отправитель плохой.
    if (senderCheck && !senderCheck.verified) {
      const safeError = `Отправитель ${cfg.config.senderEmail} не подтверждён в этом аккаунте Brevo — письмо будет принято и заблокировано на доставке.`;
      await recordEmailTestResult(prisma, args.siteId, { ok: false, safeError });
      return { ok: false, code: "sender_not_verified", safeError };
    }
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

  if (args.verifyTemplate) {
    const check = await args.verifyTemplate(templateId);
    // null = спросить не удалось; молчим и шлём, как раньше.
    if (check && !check.exists) {
      const safeError = `Шаблон ${templateId} не найден в этом аккаунте Brevo.`;
      await recordEmailTestResult(prisma, args.siteId, { ok: false, safeError });
      return { ok: false, code: "template_not_found", safeError };
    }
    if (check && !check.active) {
      const safeError = `Шаблон ${templateId}${check.name ? ` «${check.name}»` : ""} выключен в Brevo — письмо будет принято и не отправлено. Включите шаблон в аккаунте.`;
      await recordEmailTestResult(prisma, args.siteId, { ok: false, safeError });
      return { ok: false, code: "template_disabled", safeError };
    }
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
