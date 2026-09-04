import { describe, it, expect } from "vitest";
import { SMS_VARIABLES } from "@/modules/messaging/variables";
import { audienceLabel } from "./display";
import { evaluateConditions } from "./conditions";
import { computeScheduledAt } from "./delay";
import { resolveRecipients, planSmsRecipients, DUPLICATE_PHONE_REASON } from "./audience";
import { listSmsTriggers, isSupportedTrigger, getSmsTrigger } from "./triggers";
import { buildTestMessage, sendTestSmsViaClient } from "./testSend";

describe("conditions.evaluateConditions", () => {
  const base = { orderStatus: "CONFIRMED", paymentStatus: "PAID", deliveryDate: new Date(), apartment: "12", timezone: "UTC" };

  it("по умолчанию исключает отменённые/возвраты", () => {
    expect(evaluateConditions(null, { ...base, orderStatus: "CANCELLED" })).toMatchObject({ ok: false });
    expect(evaluateConditions(null, { ...base, paymentStatus: "REFUNDED" })).toMatchObject({ ok: false });
  });

  it("requirePaid блокирует неоплаченные", () => {
    expect(evaluateConditions({ requirePaid: true }, { ...base, paymentStatus: "UNPAID" })).toMatchObject({ ok: false, skipReason: "not_paid" });
    expect(evaluateConditions({ requirePaid: true }, base)).toEqual({ ok: true });
  });

  it("«доставка сегодня» больше НЕ условие (стало триггером) — старый ключ игнорируется", () => {
    const now = new Date("2026-07-22T10:00:00Z");
    // Правило, сохранённое до перевода в триггеры, не должно ничего отсекать.
    const legacy = { deliveryToday: true } as unknown as Parameters<typeof evaluateConditions>[0];
    expect(evaluateConditions(legacy, { ...base, deliveryDate: new Date("2026-07-30T20:00:00Z"), now })).toEqual({ ok: true });
  });

  it("allowCancelledRefunded снимает дефолтное исключение (триггеры возврата/отказа оплаты)", () => {
    const refunded = { ...base, paymentStatus: "REFUNDED" };
    expect(evaluateConditions({}, refunded)).toMatchObject({ ok: false, skipReason: "order_cancelled_or_refunded" });
    expect(evaluateConditions({}, { ...refunded, allowCancelledRefunded: true })).toEqual({ ok: true });
  });

  it("apartmentPresent требует непустой номер квартиры", () => {
    expect(evaluateConditions({ apartmentPresent: true }, { ...base, apartment: null })).toMatchObject({ ok: false, skipReason: "no_apartment" });
    expect(evaluateConditions({ apartmentPresent: true }, base)).toEqual({ ok: true });
  });
});

describe("delay.computeScheduledAt", () => {
  const from = new Date("2026-07-22T00:00:00Z");
  it("IMMEDIATE / amount<=0 → сейчас", () => {
    expect(computeScheduledAt(from, 0, "IMMEDIATE").getTime()).toBe(from.getTime());
    expect(computeScheduledAt(from, 5, "IMMEDIATE").getTime()).toBe(from.getTime());
    expect(computeScheduledAt(from, 0, "DAY").getTime()).toBe(from.getTime());
  });
  it("фиксированные единицы дают точный сдвиг", () => {
    expect(computeScheduledAt(from, 30, "MINUTE").getTime()).toBe(from.getTime() + 30 * 60_000);
    expect(computeScheduledAt(from, 1, "HOUR").getTime()).toBe(from.getTime() + 3_600_000);
    expect(computeScheduledAt(from, 30, "DAY").getTime()).toBe(from.getTime() + 30 * 86_400_000);
  });
  it("MONTH считается календарно", () => {
    expect(computeScheduledAt(from, 1, "MONTH").toISOString()).toBe("2026-08-22T00:00:00.000Z");
  });
});

describe("audience.resolveRecipients", () => {
  it("CUSTOMER → только заказчик", () => {
    const r = resolveRecipients("CUSTOMER", { senderPhone: "+15551112222", recipientPhone: "+15553334444" });
    expect(r.recipients).toEqual([{ recipientType: "CUSTOMER", phoneNormalized: "+15551112222" }]);
  });
  it("BOTH с разными номерами → заказчик и получатель раздельно", () => {
    const r = resolveRecipients("BOTH", { senderPhone: "+15551112222", recipientPhone: "+15553334444" });
    expect(r.recipients).toEqual([
      { recipientType: "CUSTOMER", phoneNormalized: "+15551112222" },
      { recipientType: "RECIPIENT", phoneNormalized: "+15553334444" },
    ]);
  });
  it("BOTH с одинаковым номером → один адресат-заказчик (без дубля)", () => {
    const r = resolveRecipients("BOTH", { senderPhone: "+1 (555) 111-2222", recipientPhone: "+15551112222" });
    expect(r.recipients).toEqual([{ recipientType: "CUSTOMER", phoneNormalized: "+15551112222" }]);
  });
  it("RECIPIENT, но номер совпадает с заказчиком → один job-ЗАКАЗЧИК (не получатель)", () => {
    const r = resolveRecipients("RECIPIENT", { senderPhone: "+15551112222", recipientPhone: "+1 (555) 111-2222" });
    expect(r.recipients).toEqual([{ recipientType: "CUSTOMER", phoneNormalized: "+15551112222" }]);
  });
  it("RECIPIENT с отдельным номером → получатель", () => {
    const r = resolveRecipients("RECIPIENT", { senderPhone: "+15551112222", recipientPhone: "+15553334444" });
    expect(r.recipients).toEqual([{ recipientType: "RECIPIENT", phoneNormalized: "+15553334444" }]);
  });
  it("отсутствующий номер пропускается с причиной PHONE_MISSING", () => {
    const r = resolveRecipients("RECIPIENT", { senderPhone: null, recipientPhone: "" });
    expect(r.recipients).toHaveLength(0);
    expect(r.skipped[0]).toMatchObject({ recipientType: "RECIPIENT", reason: "PHONE_MISSING" });
  });

  it("нераспознаваемый номер пропускается с причиной PHONE_INVALID", () => {
    const r = resolveRecipients("RECIPIENT", { senderPhone: null, recipientPhone: "abc" });
    expect(r.recipients).toHaveLength(0);
    expect(r.skipped[0]).toMatchObject({ recipientType: "RECIPIENT", reason: "PHONE_INVALID" });
  });
});

describe("audience.planSmsRecipients — один телефон, одна SMS на событие", () => {
  const SAME = { senderPhone: "+15551112222", recipientPhone: "+1 (555) 111-2222" };
  const DIFFERENT = { senderPhone: "+15551112222", recipientPhone: "+15553334444" };

  it("одинаковый номер: правило заказчика шлёт, правило получателя молчит", () => {
    const plans = planSmsRecipients(
      [
        { id: "rule-recipient", audience: "RECIPIENT" },
        { id: "rule-customer", audience: "CUSTOMER" },
      ],
      SAME
    );
    expect(plans.get("rule-customer")!.recipients).toEqual([
      { recipientType: "CUSTOMER", phoneNormalized: "+15551112222" },
    ]);
    expect(plans.get("rule-recipient")!.recipients).toHaveLength(0);
    expect(plans.get("rule-recipient")!.duplicates).toEqual([
      { recipientType: "CUSTOMER", phoneNormalized: "+15551112222" },
    ]);
  });

  it("порядок правил на входе не влияет на исход — выигрывает заказчик", () => {
    const forward = planSmsRecipients(
      [
        { id: "rule-customer", audience: "CUSTOMER" },
        { id: "rule-recipient", audience: "RECIPIENT" },
      ],
      SAME
    );
    expect(forward.get("rule-customer")!.recipients).toHaveLength(1);
    expect(forward.get("rule-recipient")!.recipients).toHaveLength(0);
  });

  it("разные номера: работают оба правила, как раньше", () => {
    const plans = planSmsRecipients(
      [
        { id: "rule-customer", audience: "CUSTOMER" },
        { id: "rule-recipient", audience: "RECIPIENT" },
      ],
      DIFFERENT
    );
    expect(plans.get("rule-customer")!.recipients).toEqual([
      { recipientType: "CUSTOMER", phoneNormalized: "+15551112222" },
    ]);
    expect(plans.get("rule-recipient")!.recipients).toEqual([
      { recipientType: "RECIPIENT", phoneNormalized: "+15553334444" },
    ]);
    expect(plans.get("rule-recipient")!.duplicates).toHaveLength(0);
  });

  it("BOTH тоже считается сообщением заказчику — правило получателя молчит", () => {
    const plans = planSmsRecipients(
      [
        { id: "rule-recipient", audience: "RECIPIENT" },
        { id: "rule-both", audience: "BOTH" },
      ],
      SAME
    );
    expect(plans.get("rule-both")!.recipients).toHaveLength(1);
    expect(plans.get("rule-recipient")!.recipients).toHaveLength(0);
  });

  it("одно правило — поведение не меняется", () => {
    const plans = planSmsRecipients([{ id: "solo", audience: "RECIPIENT" }], SAME);
    expect(plans.get("solo")!.recipients).toEqual([{ recipientType: "CUSTOMER", phoneNormalized: "+15551112222" }]);
    expect(plans.get("solo")!.duplicates).toHaveLength(0);
  });

  it("два правила с ОДНОЙ аудиторией друг друга не глушат — это настройка владельца", () => {
    const customers = planSmsRecipients(
      [
        { id: "c1", audience: "CUSTOMER" },
        { id: "c2", audience: "CUSTOMER" },
      ],
      SAME
    );
    expect(customers.get("c1")!.recipients).toHaveLength(1);
    expect(customers.get("c2")!.recipients).toHaveLength(1);

    const recipients = planSmsRecipients(
      [
        { id: "r1", audience: "RECIPIENT" },
        { id: "r2", audience: "RECIPIENT" },
      ],
      SAME
    );
    expect(recipients.get("r1")!.recipients).toHaveLength(1);
    expect(recipients.get("r2")!.recipients).toHaveLength(1);
  });

  it("причина пропуска отличается от «нет телефона»", () => {
    expect(DUPLICATE_PHONE_REASON).toBe("DUPLICATE_PHONE");
  });
});

describe("терминология: только «Заказчик»/«Получатель», без «Клиент»", () => {
  it("audienceLabel даёт «Заказчик»/«Получатель» и не содержит «Клиент»", () => {
    expect(audienceLabel("CUSTOMER")).toBe("Заказчик");
    expect(audienceLabel("RECIPIENT")).toBe("Получатель");
    for (const a of ["CUSTOMER", "RECIPIENT", "BOTH"]) {
      expect(audienceLabel(a).toLowerCase()).not.toContain("клиент");
    }
  });
  it("подписи переменных заказчика — «заказчик», не «клиент»", () => {
    const byKey = Object.fromEntries(SMS_VARIABLES.map((v) => [v.key, v.label]));
    expect(byKey["sender_name"]).toBe("Имя заказчика");
    expect(byKey["sender_phone"]).toBe("Телефон заказчика");
    for (const v of SMS_VARIABLES) expect(v.label.toLowerCase()).not.toContain("клиент");
  });
});

describe("triggers registry", () => {
  it("все триггеры зарегистрированы", () => {
    const types = listSmsTriggers().map((t) => t.type);
    expect(types).toEqual([
      "ORDER_CREATED",
      "ORDER_PAID",
      "ORDER_CANCELLED",
      "TRACKING_LINK_AVAILABLE",
      "DELIVERY_TODAY",
      // Эскалация «получатель молчит»: переспросить его, затем сказать заказчику.
      "RECIPIENT_NO_REPLY",
      "RECIPIENT_UNREACHABLE",
      "PAYMENT_PENDING",
      "PAYMENT_FAILED",
      "ORDER_REFUNDED",
      "ORDER_DELIVERED",
    ]);
  });
  it("isSupportedTrigger / getSmsTrigger отбрасывают неизвестное", () => {
    expect(isSupportedTrigger("ORDER_CREATED")).toBe(true);
    expect(isSupportedTrigger("ANNIVERSARY_REMINDER")).toBe(false);
    expect(getSmsTrigger("nope")).toBeNull();
  });
  it("TRACKING_LINK_AVAILABLE требует tracking_url", () => {
    expect(getSmsTrigger("TRACKING_LINK_AVAILABLE")?.requiredVars).toContain("tracking_url");
  });
});

describe("testSend (тест не создаёт production-задачу)", () => {
  it("buildTestMessage рендерит примерные переменные и реальные поля магазина", () => {
    const body = buildTestMessage("Hi from {{store_name}}, review: {{review_url}}", {
      name: "Floremart", quoPhoneNumber: "+15550000000", reviewUrl: "https://rev",
    });
    expect(body).toContain("[ТЕСТ]");
    expect(body).toContain("Floremart");
    expect(body).toContain("https://rev");
    expect(body).not.toContain("undefined");
  });

  it("sendTestSmsViaClient только вызывает клиент (без записи в БД — нет prisma)", async () => {
    const calls: unknown[] = [];
    const fakeClient = { sendMessage: async (i: unknown) => { calls.push(i); return { id: "AC1", conversationId: "CN1" }; } };
    await sendTestSmsViaClient(fakeClient as never, { fromId: "PN1", to: "+15551112222", body: "[ТЕСТ] hi" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ from: "PN1", to: ["+15551112222"] });
  });
});
