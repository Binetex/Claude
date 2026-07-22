import { describe, it, expect } from "vitest";
import { isSafeMetaValue, safePaymentMeta } from "./redact";

describe("isSafeMetaValue — PII/секреты не проходят", () => {
  it("пропускает короткие статус-токены/суммы/валюту", () => {
    for (const v of ["AUTHORIZED", "SUCCEEDED", "pay_later", "PENDING", "GBP", "12.50", "true", "int_status_ok"]) {
      expect(isSafeMetaValue(v), v).toBe(true);
    }
  });

  it("режет email/телефон/имена/сообщения/длинные id/объекты", () => {
    for (const v of [
      "john@example.com", // email
      "+44 7700 900123", // phone
      "1234567890", // длинные цифры
      "int_1a2b3c4d5e6f7g8h9i0j", // длинный id
      "Happy Birthday my dear friend", // многословный текст (открытка)
      "Ann Recipient Smith", // имя (>3 слов не нужно, но 3 ок — проверим 4-словное)
      "a".repeat(41), // слишком длинно
      { foo: "bar" }, // объект
      null,
    ]) {
      expect(isSafeMetaValue(v), JSON.stringify(v)).toBe(false);
    }
  });
});

describe("safePaymentMeta — только платёжные ключи, без PII-ключей", () => {
  it("показывает airwallex-статус, но не имя/сообщение даже если попали в payment-подобные ключи", () => {
    const meta = [
      { key: "_airwallex_payment_status", value: "AUTHORIZED" },
      { key: "_klarna_pay_later", value: "yes" },
      { key: "_billing_payment_name", value: "John Buyer" }, // PII-ключ (name) — режем
      { key: "_delivery_card_message", value: "payment love note" }, // card/message PII-ключ — режем
      { key: "_transaction_ref", value: "int_123456789012" }, // длинный id — режется по значению
      { key: "product_title", value: "Roses" }, // не платёжный ключ
    ];
    const out = safePaymentMeta(meta);
    const keys = out.map((x) => x.key);
    expect(keys).toContain("_airwallex_payment_status");
    expect(keys).toContain("_klarna_pay_later");
    expect(keys).not.toContain("_billing_payment_name");
    expect(keys).not.toContain("_delivery_card_message");
    expect(keys).not.toContain("_transaction_ref");
    expect(keys).not.toContain("product_title");
  });
});
