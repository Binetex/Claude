import { describe, it, expect } from "vitest";
import { resolveMappedOrderFields, collectMetaKeys } from "./orderMeta";

describe("resolveMappedOrderFields (сценарий 11 — configurable meta mapping)", () => {
  const meta = [
    { key: "_delivery_date", value: "2026-08-01" },
    { key: "_delivery_time", value: "14:00–18:00" },
    { key: "card_message", value: "С днём рождения" },
    { key: "recipient_phone", value: "+1000" },
    { key: "irrelevant", value: "x" },
  ];

  it("извлекает значения по настроенному mapping", () => {
    const r = resolveMappedOrderFields(meta, {
      deliveryDate: "_delivery_date",
      deliveryWindow: "_delivery_time",
      cardMessage: "card_message",
      recipientPhone: "recipient_phone",
    });
    expect(r).toEqual({
      deliveryDate: "2026-08-01",
      deliveryWindow: "14:00–18:00",
      cardMessage: "С днём рождения",
      recipientPhone: "+1000",
    });
  });

  it("не хардкодит: без mapping ничего не извлекает", () => {
    expect(resolveMappedOrderFields(meta, null)).toEqual({});
    expect(resolveMappedOrderFields(meta, {})).toEqual({});
  });

  it("несуществующий ключ mapping пропускается", () => {
    expect(resolveMappedOrderFields(meta, { deliveryDate: "_nope" })).toEqual({});
  });
});

describe("collectMetaKeys — автоподсказка ключей (без значений/PII)", () => {
  it("считает частоту ключей по выборке, сортирует по убыванию", () => {
    const orders = [
      { meta_data: [{ key: "_delivery_date", value: "a" }, { key: "card_message", value: "b" }] },
      { meta_data: [{ key: "_delivery_date", value: "c" }] },
    ];
    const keys = collectMetaKeys(orders);
    expect(keys[0]).toEqual({ key: "_delivery_date", count: 2 });
    expect(keys.find((k) => k.key === "card_message")).toEqual({ key: "card_message", count: 1 });
    // значения не утекают в результат
    expect(JSON.stringify(keys)).not.toContain("value");
  });
});
