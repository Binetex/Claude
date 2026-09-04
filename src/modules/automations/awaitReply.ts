/**
 * «Ждём ответ получателя» — граница осмысленности флага правила.
 *
 * Флаг включает эскалацию (`recipientFollowup.ts`): молчание после сообщения → повтор
 * получателю → сообщение заказчику. Ждать ответа можно только там, где сообщение реально
 * уходит ЕМУ и по SMS: заказчику эскалация адресована не будет, а письмо в цепочку не входит.
 *
 * Модуль отдельный и намеренно чистый: одно и то же правило нужно форме («галочка доступна?»),
 * server action'у («что записать в БД?») и тесту. Копии этой формулы разъехались бы —
 * форма разрешала бы то, что сервер молча срезает.
 */
import type { SmsAudience } from "./audience";

export type AwaitReplyRule = { smsEnabled: boolean; audience: SmsAudience };

/** Может ли у ТАКОГО правила вообще стоять галочка. */
export function canAwaitRecipientReply(rule: AwaitReplyRule): boolean {
  return rule.smsEnabled && (rule.audience === "RECIPIENT" || rule.audience === "BOTH");
}

/**
 * Итоговое значение флага при сохранении. Считается на сервере: форму можно обойти, а флаг на
 * правиле заказчику завёл бы цепочку, которая ждёт ответа от того, кому ничего не отправляли.
 */
export function resolveAwaitRecipientReply(input: AwaitReplyRule & { awaitRecipientReply?: boolean | null }): boolean {
  return !!input.awaitRecipientReply && canAwaitRecipientReply(input);
}

/**
 * Заводить ли цепочку после УСПЕШНО отправленного сообщения.
 *
 * Отдельной функцией, потому что это и есть смысл всей правки: раньше решение принимал тип
 * события («Доставка сегодня»), теперь — галочка на правиле. Условие в обработчике проверить
 * тестом дорого (нужны БД, канал и очередь), а вернуть его к старому виду — одна строка,
 * поэтому граница живёт здесь и закреплена тестом.
 */
export function shouldScheduleRecipientFollowup(
  job: { channel: string; recipientType: string },
  automation: { awaitRecipientReply: boolean }
): boolean {
  // Ждём ответ на SMS и только от получателя: заказчику этот вопрос не задавали. recipientType
  // здесь фактический (audience.ts переписывает его в CUSTOMER, когда номера совпали), поэтому
  // на заказе с одним телефоном на двоих цепочка не заводится — человеку и так пишут как заказчику.
  return job.channel === "SMS" && job.recipientType === "RECIPIENT" && automation.awaitRecipientReply;
}
