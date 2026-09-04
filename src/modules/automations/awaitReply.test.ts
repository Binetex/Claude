import { describe, it, expect } from "vitest";
import { canAwaitRecipientReply, resolveAwaitRecipientReply, shouldScheduleRecipientFollowup } from "./awaitReply";

/**
 * «Ждём ответ получателя» — свойство КОНКРЕТНОГО правила.
 *
 * История: сначала эскалацию запускало любое SMS получателю по событию «Доставка сегодня».
 * Правило такое было одно, но второе на то же событие молча завело бы вторую цепочку —
 * лишние сообщения живому человеку и лишняя тревога заказчику. Теперь цепочку заводит только
 * правило, где владелец включил флаг.
 *
 * Здесь закреплена граница осмысленности флага: ждать ответа можно лишь там, где сообщение
 * реально уходит получателю по SMS. Проверяется НАСТОЯЩАЯ функция — та же, что зовут форма
 * (доступность галочки) и server action (что записать в БД).
 */
describe("когда правило может ждать ответа получателя", () => {
  it("SMS получателю — можно", () => {
    expect(resolveAwaitRecipientReply({ awaitRecipientReply: true, smsEnabled: true, audience: "RECIPIENT" })).toBe(true);
  });

  it("SMS обоим — можно: получатель среди адресатов", () => {
    expect(resolveAwaitRecipientReply({ awaitRecipientReply: true, smsEnabled: true, audience: "BOTH" })).toBe(true);
  });

  it("сообщение заказчику — нельзя: ждать ответа от того, кому не писали, бессмысленно", () => {
    expect(resolveAwaitRecipientReply({ awaitRecipientReply: true, smsEnabled: true, audience: "CUSTOMER" })).toBe(false);
  });

  it("SMS выключен — нельзя: письмо в эту цепочку не входит", () => {
    expect(resolveAwaitRecipientReply({ awaitRecipientReply: true, smsEnabled: false, audience: "RECIPIENT" })).toBe(false);
  });

  it("флаг не поставлен — цепочки нет даже у подходящего правила", () => {
    expect(resolveAwaitRecipientReply({ smsEnabled: true, audience: "RECIPIENT" })).toBe(false);
  });

  it("null вместо флага (пришло из БД старой записи) — цепочки нет", () => {
    expect(resolveAwaitRecipientReply({ awaitRecipientReply: null, smsEnabled: true, audience: "RECIPIENT" })).toBe(false);
  });
});

describe("доступность галочки в форме", () => {
  // Форма и сервер обязаны отвечать одинаково: иначе владелец ставит галочку, сохраняет —
  // и она молча не сохраняется.
  const cases: { rule: { smsEnabled: boolean; audience: "CUSTOMER" | "RECIPIENT" | "BOTH" }; available: boolean }[] = [
    { rule: { smsEnabled: true, audience: "RECIPIENT" }, available: true },
    { rule: { smsEnabled: true, audience: "BOTH" }, available: true },
    { rule: { smsEnabled: true, audience: "CUSTOMER" }, available: false },
    { rule: { smsEnabled: false, audience: "RECIPIENT" }, available: false },
    { rule: { smsEnabled: false, audience: "BOTH" }, available: false },
    { rule: { smsEnabled: false, audience: "CUSTOMER" }, available: false },
  ];

  for (const { rule, available } of cases) {
    it(`${rule.audience}, SMS ${rule.smsEnabled ? "включён" : "выключен"} — галочка ${available ? "доступна" : "недоступна"}`, () => {
      expect(canAwaitRecipientReply(rule)).toBe(available);
      // Галочка доступна ровно тогда, когда поставленный флаг переживает сохранение.
      expect(resolveAwaitRecipientReply({ ...rule, awaitRecipientReply: true })).toBe(available);
    });
  }
});

describe("что запускает цепочку после отправки", () => {
  const sms = { channel: "SMS", recipientType: "RECIPIENT" };

  it("SMS получателю по правилу с галочкой — цепочка заводится", () => {
    expect(shouldScheduleRecipientFollowup(sms, { awaitRecipientReply: true })).toBe(true);
  });

  it("та же отправка без галочки — не заводится", () => {
    // Главная проверка всей правки: раньше здесь стояло `automation.triggerType === "DELIVERY_TODAY"`,
    // и цепочку заводило любое правило на это событие. Возврат старого условия обязан ронять тест.
    expect(shouldScheduleRecipientFollowup(sms, { awaitRecipientReply: false })).toBe(false);
  });

  it("письмо — не заводит: ждать ответа на email эта цепочка не умеет", () => {
    expect(shouldScheduleRecipientFollowup({ channel: "EMAIL", recipientType: "RECIPIENT" }, { awaitRecipientReply: true })).toBe(false);
  });

  it("SMS заказчику — не заводит: вопрос задавали не ему", () => {
    // Сюда же попадает заказ с одним телефоном на двоих: audience.ts переписывает recipientType
    // в CUSTOMER, и человек, которому и так пишут как заказчику, эскалацию не получает.
    expect(shouldScheduleRecipientFollowup({ channel: "SMS", recipientType: "CUSTOMER" }, { awaitRecipientReply: true })).toBe(false);
  });
});
