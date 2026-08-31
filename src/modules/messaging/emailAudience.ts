/**
 * Разворачивание аудитории EMAIL-канала. В отличие от SMS (automations/audience.ts), Email всегда идёт
 * ТОЛЬКО заказчику (CUSTOMER) — независимо от Automation.audience: у флориста/получателя цветов
 * обычно нет своего email в системе, и спецификация прямо требует использовать email заказчика
 * из заказа, не подменяя его email получателя.
 */
import { normalizeEmail } from "@/integrations/email/brevo";

export type EmailAudienceSource = { senderEmail: string | null };

export type ResolvedEmailRecipient = { recipientType: "CUSTOMER"; emailNormalized: string };
export type SkippedEmailRecipient = { recipientType: "CUSTOMER"; reason: "EMAIL_MISSING" | "EMAIL_INVALID" };

export type ResolveEmailResult =
  | { ok: true; recipient: ResolvedEmailRecipient }
  | { ok: false; skipped: SkippedEmailRecipient };

export function resolveCustomerEmail(order: EmailAudienceSource): ResolveEmailResult {
  const normalized = normalizeEmail(order.senderEmail);
  if (normalized) return { ok: true, recipient: { recipientType: "CUSTOMER", emailNormalized: normalized } };
  return { ok: false, skipped: { recipientType: "CUSTOMER", reason: order.senderEmail ? "EMAIL_INVALID" : "EMAIL_MISSING" } };
}
