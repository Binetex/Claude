import { describe, it, expect } from "vitest";
import { renderTemplate, extractVariables } from "./template";
import { buildOrderVariables, SMS_VARIABLES } from "./variables";
import { audienceLabel } from "./display";
import { evaluateConditions } from "./conditions";
import { computeScheduledAt } from "./delay";
import { resolveRecipients } from "./audience";
import { listSmsTriggers, isSupportedTrigger, getSmsTrigger } from "./triggers";
import { buildTestMessage, sendTestSmsViaClient } from "./testSend";

describe("template.renderTemplate", () => {
  it("подставляет значения переменных", () => {
    const r = renderTemplate("Hi {{name}}, order {{num}}", { name: "Anna", num: "#1" });
    expect(r.text).toBe("Hi Anna, order #1");
    expect(r.missing).toEqual([]);
  });

  it("отсутствующая/пустая переменная → '' (никогда не 'undefined') и попадает в missing", () => {
    const r = renderTemplate("Track: {{tracking_url}} end", { tracking_url: "" });
    expect(r.text).not.toContain("undefined");
    expect(r.missing).toContain("tracking_url");
  });

  it("строка, ставшая пустой из-за подстановки, схлопывается (нет висячих пустых строк)", () => {
    const r = renderTemplate("Hello\n{{tracking_url}}\nBye", {});
    expect(r.text).toBe("Hello\nBye");
  });

  it("extractVariables возвращает уникальные имена в порядке появления", () => {
    expect(extractVariables("{{a}} {{b}} {{a}}")).toEqual(["a", "b"]);
  });
});

describe("variables.buildOrderVariables", () => {
  it("форматирует адрес/дату/деньги и пустые поля → ''", () => {
    const v = buildOrderVariables({
      orderNumber: "#1001", senderName: "Anna", recipientName: "Maria",
      senderPhone: "+15551112222", recipientPhone: "+15553334444",
      addressLine: "1 Main St", apartment: "4", city: "Portland",
      deliveryDate: new Date("2026-07-25T12:00:00Z"), deliveryWindow: "14:00 – 18:00",
      trackingUrl: null, cardMessage: "", deliveryInstructions: "Leave at door",
      customerTotal: 115, storeName: "Floremart", storePhone: "+15550000000",
      reviewUrl: "https://rev", timezone: "UTC",
    });
    expect(v.order_number).toBe("#1001");
    expect(v.delivery_address).toBe("1 Main St, 4, Portland");
    expect(v.delivery_date).toBe("2026-07-25");
    expect(v.order_total).toBe("$115.00");
    expect(v.tracking_url).toBe(""); // null → ""
    expect(v.card_message).toBe("");
    expect(v.review_url).toBe("https://rev");
  });
});

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

  it("deliveryToday сравнивает по таймзоне", () => {
    const now = new Date("2026-07-22T10:00:00Z");
    expect(evaluateConditions({ deliveryToday: true }, { ...base, deliveryDate: new Date("2026-07-22T20:00:00Z"), now })).toEqual({ ok: true });
    expect(evaluateConditions({ deliveryToday: true }, { ...base, deliveryDate: new Date("2026-07-23T20:00:00Z"), now })).toMatchObject({ ok: false, skipReason: "not_delivery_today" });
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
  it("отсутствующий/битый номер пропускается с причиной", () => {
    const r = resolveRecipients("RECIPIENT", { senderPhone: null, recipientPhone: "" });
    expect(r.recipients).toHaveLength(0);
    expect(r.skipped[0]).toMatchObject({ recipientType: "RECIPIENT", reason: "invalid_or_missing_phone" });
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
  it("MVP-триггеры зарегистрированы", () => {
    const types = listSmsTriggers().map((t) => t.type);
    expect(types).toEqual(["ORDER_CREATED", "TRACKING_LINK_AVAILABLE", "ORDER_DELIVERED"]);
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
