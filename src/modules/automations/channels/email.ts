import "server-only";
/**
 * EMAIL-канал: реализация ChannelSender поверх существующей Email-интеграции (settings.ts +
 * brevo.ts, Stage 1). Гейтинг (магазин настроил Email? домен подтверждён? есть шаблон для этого
 * события?) выполняет resolveSiteEmailConfig/resolveSiteTemplateId и мапится в skip (config-
 * проблема, не сбой отправки) — так же, как store_no_quo_number у SMS.
 *
 * Идемпотентность — по ctx.idempotencyKey, ключ формирует движок (handlers.ts) per-attempt.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { createBrevoProvider } from "@/integrations/email/brevo";
import { resolveBrevoApiKey } from "@/integrations/email/accountKey";
import { resolveSiteEmailConfig, resolveSiteTemplateId } from "@/integrations/email/settings";
import type { ChannelSender, ChannelSendContext, ChannelSendResult } from "./types";

// Config/precondition-коды: магазин ещё не готов слать Email → job SKIPPED, не FAILED.
const SKIP_CODES = new Set([
  "email_not_configured",
  "site_email_disabled",
  "site_email_not_configured",
  "site_domain_not_verified",
  "site_template_missing",
  "invalid_recipient_email",
  "invalid_sender_email",
  "invalid_template_id",
]);
const RETRYABLE_CODES = new Set(["brevo_rate_limit", "brevo_server", "brevo_network", "brevo_timeout"]);

export function createEmailChannelSender(prisma: PrismaClient): ChannelSender {
  return {
    channel: "EMAIL",
    async send(ctx: ChannelSendContext): Promise<ChannelSendResult> {
      if (!ctx.emailNormalized) {
        return { ok: false, code: "email_missing", retryable: false, skip: true };
      }

      const cfg = await resolveSiteEmailConfig(prisma, ctx.siteId);
      if (!cfg.ok) return { ok: false, code: cfg.skip, retryable: false, skip: true };

      const tpl = await resolveSiteTemplateId(prisma, ctx.siteId, ctx.triggerType);
      if (!tpl.ok) return { ok: false, code: tpl.skip, retryable: false, skip: true };

      const apiKey = await resolveBrevoApiKey(prisma);
      const provider = createBrevoProvider(apiKey);
      const res = await provider.sendTemplate({
        to: ctx.emailNormalized,
        brevoTemplateId: tpl.templateId,
        params: ctx.vars,
        sender: { email: cfg.config.senderEmail, name: cfg.config.senderName, brevoSenderId: cfg.config.brevoSenderId },
        replyTo: cfg.config.replyTo,
      });

      if (res.ok) return { ok: true, providerMessageId: res.providerMessageId };
      return { ok: false, code: res.code, retryable: RETRYABLE_CODES.has(res.code), skip: SKIP_CODES.has(res.code) };
    },
  };
}
