import { describe, it, expect } from "vitest";
import { readTemplates, writeTemplates, templateApplies } from "./templates";
import { INTENTS, getIntent } from "./intents";

/**
 * Заготовки магазина. Главное здесь — что «вот ваш трек» без трека не уйдёт никогда, и что
 * ничего не настроивший магазин всё равно отвечает на частые вопросы без обращения к модели.
 */
describe("настройки заготовок", () => {
  it("магазин ничего не настраивал — заготовки работают текстами по умолчанию", () => {
    const t = readTemplates(null);
    for (const def of INTENTS) {
      expect(t[def.key].enabled).toBe(true);
      expect(t[def.key].text).toBe(def.defaultText);
    }
  });

  it("свой текст и выключение переживают запись и чтение", () => {
    const stored = writeTemplates({
      tracking: { enabled: true, text: "Track it here: {{tracking_url}}" },
      delivery_time: { enabled: false, text: "" },
      delivered_check: { enabled: true, text: "" },
    });
    const back = readTemplates(stored);

    expect(back.tracking.text).toBe("Track it here: {{tracking_url}}");
    expect(back.delivery_time.enabled).toBe(false);
    // Пустой текст у включённой заготовки — это «как по умолчанию», а не «молчать».
    expect(back.delivered_check.text).toBe(getIntent("delivered_check")!.defaultText);
  });

  it("мусор вместо настроек не ломает ассистента", () => {
    const t = readTemplates("не json");
    expect(t.tracking.enabled).toBe(true);
  });
});

describe("применима ли заготовка", () => {
  const tracking = getIntent("tracking")!;

  it("трек есть — отвечаем заготовкой", () => {
    expect(templateApplies(tracking, { enabled: true, text: "…{{tracking_url}}" }, { tracking_url: "https://t" })).toBe(true);
  });

  it("трека нет — заготовка не годится, отвечает модель", () => {
    expect(templateApplies(tracking, { enabled: true, text: "…{{tracking_url}}" }, { tracking_url: "" })).toBe(false);
  });

  it("выключенная заготовка не используется", () => {
    expect(templateApplies(tracking, { enabled: false, text: "…" }, { tracking_url: "https://t" })).toBe(false);
  });

  it("заготовка со словом «сегодня» и «доставлен» подчиняются состоянию заказа", () => {
    const today = INTENTS.find((i) => i.key === "delivery_time")!;
    const delivered = INTENTS.find((i) => i.key === "delivered_check")!;
    const on = { enabled: true, text: "x {{delivery_time}}" };
    const vars = { delivery_time: "2-4pm" };
    expect(templateApplies(today, on, vars, { deliveryStatus: "PENDING", deliveryIsToday: true })).toBe(true);
    expect(templateApplies(today, on, vars, { deliveryStatus: "PENDING", deliveryIsToday: false })).toBe(false);
    expect(templateApplies(today, on, vars, { deliveryStatus: "DELIVERED", deliveryIsToday: true })).toBe(false);
    expect(templateApplies(delivered, { enabled: true, text: "done" }, {}, { deliveryStatus: "DELIVERED", deliveryIsToday: false })).toBe(true);
    expect(templateApplies(delivered, { enabled: true, text: "done" }, {}, { deliveryStatus: "PENDING", deliveryIsToday: true })).toBe(false);
  });
});
