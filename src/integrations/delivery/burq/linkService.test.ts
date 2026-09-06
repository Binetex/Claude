import { describe, it, expect } from "vitest";
import { extractBurqOrderId, isBurqOrderId } from "./linkService";

describe("extractBurqOrderId — что бы ни вставил флорист", () => {
  it("чистый id, ссылка из кабинета Burq, пробелы и решётка", () => {
    expect(extractBurqOrderId("o_01m1q64qnsfd29g42mz2zx74jb")).toBe("o_01m1q64qnsfd29g42mz2zx74jb");
    expect(extractBurqOrderId("https://dashboard.burq.ai/orders/o_01m1q64qnsfd29g42mz2zx74jb?tab=details")).toBe("o_01m1q64qnsfd29g42mz2zx74jb");
    expect(extractBurqOrderId("  o_01m1q64qnsfd29g42mz2zx74jb \n")).toBe("o_01m1q64qnsfd29g42mz2zx74jb");
    expect(extractBurqOrderId("#o_01m1q64qnsfd29g42mz2zx74jb")).toBe("o_01m1q64qnsfd29g42mz2zx74jb");
    expect(isBurqOrderId(extractBurqOrderId("Order o_01m1q64qnsfd29g42mz2zx74jb"))).toBe(true);
  });
  it("id доставки del_… не превращается в id заказа", () => {
    const v = extractBurqOrderId("del_01m1q64qnsfd29g42mz2zx74jb");
    expect(v).toBe("del_01m1q64qnsfd29g42mz2zx74jb");
    expect(isBurqOrderId(v)).toBe(false);
  });
});
