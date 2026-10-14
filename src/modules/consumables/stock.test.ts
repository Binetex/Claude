import { describe, it, expect } from "vitest";
import { stockByFlorist, stockTotal, NO_FLORIST } from "./stock";

/**
 * Пример владельца 14.10.2026: 500 коробок из Китая пришли Ольге, Ольга передала 200 Насте,
 * каждая что-то положила в свои заказы.
 */
describe("остаток расходников по флористам", () => {
  const receipts = [
    { itemId: "box", floristId: "olga", quantity: 500, transferId: null, day: "2026-10-14" },
    { itemId: "box", floristId: "olga", quantity: -200, transferId: "t1", day: "2026-10-16" },
    { itemId: "box", floristId: "nastya", quantity: 200, transferId: "t1", day: "2026-10-16" },
  ];
  const usages = [
    { itemId: "box", floristId: "olga", day: "2026-10-15", quantity: 30 },
    { itemId: "box", floristId: "nastya", day: "2026-10-17", quantity: 12 },
  ];
  const stock = stockByFlorist(receipts, usages);

  it("у каждого — свой приход, передачи и расход", () => {
    expect(stock.get("box")!.get("olga")).toEqual({ received: 500, transferred: -200, used: 30, left: 270, since: "2026-10-14" });
    expect(stock.get("box")!.get("nastya")).toEqual({ received: 0, transferred: 200, used: 12, left: 188, since: "2026-10-16" });
  });

  it("в общем итоге передачи между флористами гасятся", () => {
    expect(stockTotal(stock.get("box"))).toEqual({ received: 500, transferred: 0, used: 42, left: 458 });
  });

  it("расход ДО первого прихода не вычитается: учёт начали вести позже заказов", () => {
    // Ольга клала коробки с августа из старых, незаписанных запасов — 500 новых не становятся 387.
    const s = stockByFlorist([receipts[0]], [{ itemId: "box", floristId: "olga", day: "2026-09-01", quantity: 113 }]);
    expect(s.get("box")!.get("olga")!.left).toBe(500);
  });

  it("нет прихода — флорист расходник не ведёт: ячейки нет, а не сотни минусов", () => {
    const s = stockByFlorist([], [{ itemId: "vase", floristId: "olga", day: "2026-10-15", quantity: 3 }]);
    expect(s.get("vase")).toBeUndefined();
  });

  it("после прихода расход сверх него — минус: значит, приход записан не весь", () => {
    const s = stockByFlorist(
      [{ itemId: "vase", floristId: "olga", quantity: 2, transferId: null, day: "2026-10-14" }],
      [{ itemId: "vase", floristId: "olga", day: "2026-10-15", quantity: 3 }]
    );
    expect(s.get("vase")!.get("olga")!.left).toBe(-1);
  });

  it("приход до разделения и заказы без флориста — отдельной графой «без флориста»", () => {
    const s = stockByFlorist(
      [{ itemId: "box", floristId: null, quantity: 567, transferId: null, day: "2026-10-14" }],
      [{ itemId: "box", floristId: null, day: "2026-10-14", quantity: 7 }]
    );
    expect(s.get("box")!.get(NO_FLORIST)!.left).toBe(560);
  });
});
