import { describe, it, expect } from "vitest";
import { formatDeliveryWindow } from "./timeWindow";

/**
 * Значения взяты с прода 21.09.2026: все 32 разных окна, какие есть в базе. Клиенту уходит
 * именно эта строка, поэтому проверяется каждая форма, а не пара удобных.
 */
describe("окно доставки для клиента", () => {
  it("24-часовые окна TheFlow и Julie's становятся американскими", () => {
    expect(formatDeliveryWindow("11:00 - 15:00")).toBe("11 AM - 3 PM");
    expect(formatDeliveryWindow("15:00 - 19:00")).toBe("3 PM - 7 PM");
    expect(formatDeliveryWindow("18:00 - 21:00")).toBe("6 PM - 9 PM");
    expect(formatDeliveryWindow("09:00 - 15:00")).toBe("9 AM - 3 PM");
    expect(formatDeliveryWindow("11:00 - 13:00")).toBe("11 AM - 1 PM");
  });

  it("неровные минуты сохраняются", () => {
    expect(formatDeliveryWindow("15:05 - 18:00")).toBe("3:05 PM - 6 PM");
    expect(formatDeliveryWindow("18:05 - 22:00")).toBe("6:05 PM - 10 PM");
  });

  it("уже американские окна только подчищаются от «:00»", () => {
    expect(formatDeliveryWindow("11:30 AM - 5:00 PM")).toBe("11:30 AM - 5 PM");
    expect(formatDeliveryWindow("4:00 PM - 9:00 PM")).toBe("4 PM - 9 PM");
    expect(formatDeliveryWindow("3:00 pm - 7:00 PM")).toBe("3 PM - 7 PM");
    expect(formatDeliveryWindow("12:00 PM - 8:00 PM")).toBe("12 PM - 8 PM");
    expect(formatDeliveryWindow("5:00 PM")).toBe("5 PM");
  });

  it("точка вместо двоеточия тоже читается", () => {
    expect(formatDeliveryWindow("10.30-11.00 AM")).toBe("10:30 AM-11 AM");
  });

  it("час с am/pm без минут приводится к одному виду", () => {
    expect(formatDeliveryWindow("3pm")).toBe("3 PM");
    expect(formatDeliveryWindow("3PM")).toBe("3 PM");
    expect(formatDeliveryWindow("3 PM")).toBe("3 PM");
    expect(formatDeliveryWindow("6pm")).toBe("6 PM");
    expect(formatDeliveryWindow("after 10am")).toBe("after 10 AM");
    expect(formatDeliveryWindow("before 5pm")).toBe("before 5 PM");
    expect(formatDeliveryWindow("until 3pm")).toBe("until 3 PM");
    expect(formatDeliveryWindow("after 2pm")).toBe("after 2 PM");
  });

  it("полночь и полдень не превращаются в ноль часов", () => {
    expect(formatDeliveryWindow("00:30 - 01:00")).toBe("12:30 AM - 1 AM");
    expect(formatDeliveryWindow("12:00 - 13:00")).toBe("12 PM - 1 PM");
  });

  it("голое число без минут и без am/pm не трогаем: полдень это или полночь — неизвестно", () => {
    expect(formatDeliveryWindow("до 12")).toBe("до 12");
    expect(formatDeliveryWindow("до 5 вечера")).toBe("до 5 вечера");
  });

  it("фразы и прочерк остаются как есть", () => {
    expect(formatDeliveryWindow("желательно первым")).toBe("желательно первым");
    expect(formatDeliveryWindow("—")).toBe("—");
    expect(formatDeliveryWindow("")).toBe("");
    expect(formatDeliveryWindow(null)).toBe("");
  });

  it("невозможное время не переписывается наугад", () => {
    expect(formatDeliveryWindow("25:00 - 30:00")).toBe("25:00 - 30:00");
    expect(formatDeliveryWindow("12:99")).toBe("12:99");
  });

  it("час больше двенадцати рядом с PM читается как 24-часовой, а не как подпись", () => {
    expect(formatDeliveryWindow("15:00 PM")).toBe("3 PM");
  });
});
