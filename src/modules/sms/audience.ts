/**
 * Разворачивание аудитории правила в конкретных адресатов job'ов. BOTH → CUSTOMER + RECIPIENT,
 * но если нормализованные номера совпадают — ОДИН адресат (одно сообщение, без дублей). Адресат
 * без валидного номера пропускается с понятной причиной. recipientType job'а — строго CUSTOMER
 * или RECIPIENT (BOTH сюда не попадает by design).
 */
import { toE164 } from "@/lib/phone";

export type SmsAudience = "CUSTOMER" | "RECIPIENT" | "BOTH";
export type SmsRecipientType = "CUSTOMER" | "RECIPIENT";

export type ResolvedRecipient = { recipientType: SmsRecipientType; phoneNormalized: string };
export type SkippedRecipient = { recipientType: SmsRecipientType; reason: string };

export type AudienceSource = { senderPhone: string | null; recipientPhone: string | null };

export type ResolveResult = { recipients: ResolvedRecipient[]; skipped: SkippedRecipient[] };

export function resolveRecipients(audience: SmsAudience, order: AudienceSource): ResolveResult {
  const want: SmsRecipientType[] =
    audience === "BOTH" ? ["CUSTOMER", "RECIPIENT"] : [audience];

  const recipients: ResolvedRecipient[] = [];
  const skipped: SkippedRecipient[] = [];
  const seenPhones = new Set<string>();

  for (const recipientType of want) {
    const raw = recipientType === "CUSTOMER" ? order.senderPhone : order.recipientPhone;
    const e164 = toE164(raw);
    if (!e164) {
      skipped.push({ recipientType, reason: "invalid_or_missing_phone" });
      continue;
    }
    // Дедуп по номеру: BOTH с одинаковым номером → один job (первым выигрывает CUSTOMER).
    if (seenPhones.has(e164)) continue;
    seenPhones.add(e164);
    recipients.push({ recipientType, phoneNormalized: e164 });
  }

  return { recipients, skipped };
}
