/**
 * Разворачивание аудитории правила в конкретных адресатов job'ов. Есть только две роли —
 * ЗАКАЗЧИК (CUSTOMER, номер billing/отправителя) и ПОЛУЧАТЕЛЬ (RECIPIENT, номер доставки),
 * третьей сущности «клиент» нет.
 *
 * Ключевое правило совпадения номеров: если номер после нормализации E.164 совпадает с номером
 * ЗАКАЗЧИКА — это один и тот же человек (заказчик указал свой телефон и в billing, и в доставке),
 * поэтому адресат считается CUSTOMER/«Заказчик» ДАЖЕ если правило нацелено на получателя, и
 * создаётся ровно ОДИН job. recipientType job'а — строго CUSTOMER или RECIPIENT (BOTH by design нет).
 */
import { toE164 } from "@/lib/phone";

export type SmsAudience = "CUSTOMER" | "RECIPIENT" | "BOTH";
export type SmsRecipientType = "CUSTOMER" | "RECIPIENT";

export type ResolvedRecipient = { recipientType: SmsRecipientType; phoneNormalized: string };
export type SkippedRecipient = { recipientType: SmsRecipientType; reason: string };

export type AudienceSource = { senderPhone: string | null; recipientPhone: string | null };

export type ResolveResult = { recipients: ResolvedRecipient[]; skipped: SkippedRecipient[] };

export function resolveRecipients(audience: SmsAudience, order: AudienceSource): ResolveResult {
  const senderE164 = toE164(order.senderPhone);
  const want: SmsRecipientType[] =
    audience === "BOTH" ? ["CUSTOMER", "RECIPIENT"] : [audience];

  const recipients: ResolvedRecipient[] = [];
  const skipped: SkippedRecipient[] = [];
  const seenPhones = new Set<string>();

  for (const target of want) {
    const raw = target === "CUSTOMER" ? order.senderPhone : order.recipientPhone;
    const e164 = toE164(raw);
    if (!e164) {
      skipped.push({ recipientType: target, reason: "invalid_or_missing_phone" });
      continue;
    }
    // Совпал с номером заказчика → это заказчик (даже если целились в получателя).
    const recipientType: SmsRecipientType = senderE164 && e164 === senderE164 ? "CUSTOMER" : target;
    // Дедуп по номеру: один человек — один job.
    if (seenPhones.has(e164)) continue;
    seenPhones.add(e164);
    recipients.push({ recipientType, phoneNormalized: e164 });
  }

  return { recipients, skipped };
}
