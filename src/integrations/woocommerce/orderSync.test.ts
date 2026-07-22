import { describe, it, expect } from "vitest";
import { computeOrderSyncBound, INITIAL_WINDOW_DAYS } from "./orderSync";

const NOW = new Date("2026-07-18T12:00:00.000Z");

describe("computeOrderSyncBound — инкрементальная синхронизация заказов", () => {
  it("watermark пуст → начальное окно (последние 14 дней) по after", () => {
    const b = computeOrderSyncBound(null, false, NOW);
    expect(b.modifiedAfter).toBeUndefined();
    const expected = new Date(NOW.getTime() - INITIAL_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
    expect(b.after).toBe(expected);
    expect(INITIAL_WINDOW_DAYS).toBe(14);
  });

  it("watermark есть → только изменения после него (modified_after), без after", () => {
    const wm = new Date("2026-07-10T08:00:00.000Z");
    const b = computeOrderSyncBound(wm, false, NOW);
    expect(b.modifiedAfter).toBe(wm.toISOString());
    expect(b.after).toBeUndefined();
  });

  it("fullHistory → пустая граница (вся история), watermark игнорируется", () => {
    const wm = new Date("2026-07-10T08:00:00.000Z");
    expect(computeOrderSyncBound(wm, true, NOW)).toEqual({});
    expect(computeOrderSyncBound(null, true, NOW)).toEqual({});
  });

  it("кастомное окно уважается", () => {
    const b = computeOrderSyncBound(null, false, NOW, 3);
    expect(b.after).toBe(new Date(NOW.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString());
  });
});
