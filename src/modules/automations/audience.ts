/**
 * Разворачивание аудитории правила в конкретных адресатов job'ов. Есть только две роли —
 * ЗАКАЗЧИК (CUSTOMER, номер billing/отправителя) и ПОЛУЧАТЕЛЬ (RECIPIENT, номер доставки),
 * третьей сущности «клиент» нет.
 *
 * Ключевое правило совпадения номеров: если номер после нормализации E.164 совпадает с номером
 * ЗАКАЗЧИКА — это один и тот же человек (заказчик указал свой телефон и в billing, и в доставке),
 * поэтому адресат считается CUSTOMER/«Заказчик» ДАЖЕ если правило нацелено на получателя, и
 * создаётся ровно ОДИН job. recipientType job'а — строго CUSTOMER или RECIPIENT (BOTH by design нет).
 *
 * Это правило действует и МЕЖДУ правилами одного события — см. `planSmsRecipients`. Внутри одного
 * правила дедупа мало: на событие обычно висят два правила (заказчику и получателю), и когда
 * телефон в заказе один, человек получал две почти одинаковые SMS подряд.
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
      // Различаем «нет номера вообще» и «есть, но не парсится» — Email-fallback (Stage 2)
      // записывает разные причины в историю (PHONE_MISSING / PHONE_INVALID).
      skipped.push({ recipientType: target, reason: raw && raw.trim() ? "PHONE_INVALID" : "PHONE_MISSING" });
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

/** Причина пропуска: этот же человек уже получает по событию сообщение как ЗАКАЗЧИК. */
export const DUPLICATE_PHONE_REASON = "DUPLICATE_PHONE";

/** То же самое для Email: письмо заказчику по этому событию уже создано другим правилом. */
export const DUPLICATE_EMAIL_REASON = "DUPLICATE_EMAIL";

export type AudienceRule = { id: string; audience: SmsAudience };
export type RulePlan = {
  /** Кому правило реально шлёт SMS. */
  recipients: ResolvedRecipient[];
  /** Адресаты, которым сообщение по этому событию уже уходит как заказчику — job SKIPPED, без отправки. */
  duplicates: ResolvedRecipient[];
  /** Адресаты без пригодного номера (PHONE_MISSING / PHONE_INVALID). */
  skipped: SkippedRecipient[];
};

/**
 * Раскладывает адресатов по правилам ОДНОГО события. Решает ровно одну задачу: когда в заказе
 * телефон заказчика и получателя совпадают, человек не должен получить И версию «заказчику», И
 * версию «получателю» — тексты почти одинаковые, и это читается как сбой. Выигрывает версия
 * ЗАКАЗЧИКА: он платил, с ним мы общаемся, и ссылки (фото доставки, трекинг) адресованы ему.
 *
 * Правило нарочно узкое — гасится ТОЛЬКО правило с аудиторией «Получатель», чей номер совпал с
 * номером заказчика, и только если заказчику по этому же событию действительно уходит сообщение.
 * Два правила с ОДНОЙ аудиторией друг друга не глушат: это осознанная настройка владельца
 * (два разных текста на событие), а не дубль.
 *
 * Результат не зависит от порядка правил на входе, поэтому повтор trigger-события даёт тот же
 * расклад и вторых job'ов не создаёт: outbox доставляет at-least-once.
 *
 * На вход подавать ТОЛЬКО правила, которые реально дошли до отправки SMS (условия выполнены и
 * канал SMS включён) — иначе отсеянное правило «прикрыло» бы живое, и человек не получил бы ничего.
 */
export function planSmsRecipients(rules: AudienceRule[], order: AudienceSource): Map<string, RulePlan> {
  const resolved = rules.map((rule) => ({ rule, res: resolveRecipients(rule.audience, order) }));

  // Номера, на которые по этому событию уже уходит сообщение ЗАКАЗЧИКУ по правилу, которое
  // именно на заказчика и нацелено (CUSTOMER или BOTH).
  const customerPhones = new Set<string>();
  for (const { rule, res } of resolved) {
    if (rule.audience === "RECIPIENT") continue;
    for (const r of res.recipients) {
      if (r.recipientType === "CUSTOMER") customerPhones.add(r.phoneNormalized);
    }
  }

  const plans = new Map<string, RulePlan>();
  for (const { rule, res } of resolved) {
    const kept: ResolvedRecipient[] = [];
    const duplicates: ResolvedRecipient[] = [];

    for (const r of res.recipients) {
      // recipientType здесь уже переписан resolveRecipients: CUSTOMER у правила «Получателю»
      // означает, что номер совпал с номером заказчика — то есть это один и тот же человек.
      const isCollision = rule.audience === "RECIPIENT" && r.recipientType === "CUSTOMER" && customerPhones.has(r.phoneNormalized);
      (isCollision ? duplicates : kept).push(r);
    }

    plans.set(rule.id, { recipients: kept, duplicates, skipped: res.skipped });
  }

  return plans;
}
