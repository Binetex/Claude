import { describe, it, expect } from "vitest";
import { computeOrderSyncBound, shouldEmitLifecycleOnSync, orderIsFreshEnoughForTriggers, LIFECYCLE_MAX_LAG_HOURS, INITIAL_WINDOW_DAYS } from "./orderSync";

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

describe("shouldEmitLifecycleOnSync — триггеры из синхронизации", () => {
  it("инкрементальный проход по watermark публикует триггеры: это замена опоздавшего вебхука", () => {
    expect(shouldEmitLifecycleOnSync(new Date("2026-09-05T18:30:00Z"), false)).toBe(true);
  });
  it("полная история и первый проход без watermark молчат", () => {
    expect(shouldEmitLifecycleOnSync(new Date("2026-09-05T18:30:00Z"), true)).toBe(false);
    expect(shouldEmitLifecycleOnSync(null, false)).toBe(false);
  });
});

describe("возраст заказа ограничивает триггеры из синхронизации", () => {
  const now = new Date("2026-09-07T12:00:00Z");
  it("свежий заказ — живой путь", () => {
    expect(orderIsFreshEnoughForTriggers("2026-09-07T11:30:00", now)).toBe(true);
    expect(orderIsFreshEnoughForTriggers("2026-09-07T06:30:00", now)).toBe(true);
  });
  it("вчерашний — перенос истории, молчим: иначе после простоя синка уйдёт пачка SMS", () => {
    expect(orderIsFreshEnoughForTriggers("2026-09-06T12:00:00", now)).toBe(false);
    expect(orderIsFreshEnoughForTriggers(`2026-09-07T0${12 - LIFECYCLE_MAX_LAG_HOURS - 1}:00:00`, now)).toBe(false);
  });
  it("без времени изменения возраст неизвестен — молчим", () => {
    expect(orderIsFreshEnoughForTriggers(null, now)).toBe(false);
    expect(orderIsFreshEnoughForTriggers("не дата", now)).toBe(false);
  });
});
