import { describe, it, expect } from "vitest";
import { isQuoOutOfMoney } from "./balanceAlert";

/**
 * 402 — единственный отказ QUO, который означает «денег нет и не уйдёт ничего». Остальные
 * отказы про конкретное сообщение, и поднимать по ним тревогу «баланс пуст» нельзя.
 */
describe("isQuoOutOfMoney", () => {
  it("402 — это про деньги, в обоих форматах записи", () => {
    expect(isQuoOutOfMoney("402")).toBe(true);
    expect(isQuoOutOfMoney("402:0201402")).toBe(true);
    // Прежний формат: до 07.09.2026 в записи об отказе лежал только «class:status».
    expect(isQuoOutOfMoney("client:402")).toBe(true);
  });

  it("остальные отказы балансом не считаются", () => {
    expect(isQuoOutOfMoney("400:0206400")).toBe(false); // номер не прошёл A2P
    expect(isQuoOutOfMoney("403:0204403")).toBe(false); // дневной лимит
    expect(isQuoOutOfMoney("500")).toBe(false);
    // Похожие цифры внутри чужого кода за 402 не считаем.
    expect(isQuoOutOfMoney("400:1402000")).toBe(false);
    expect(isQuoOutOfMoney(null)).toBe(false);
    expect(isQuoOutOfMoney(undefined)).toBe(false);
  });
});
