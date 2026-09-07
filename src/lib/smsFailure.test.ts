import { describe, it, expect } from "vitest";
import { describeSendFailure } from "./smsFailure";

describe("describeSendFailure", () => {
  it("402 объясняет, что делать: оплатить аккаунт Quo", () => {
    // Ровно этот случай владелец увидел в Telegram как голое «quo_client».
    const text = describeSendFailure("quo_client", "402:0201402");
    expect(text).toContain("подписка истекла");
    expect(text).toContain("402:0201402");
  });

  it("400 — это про регистрацию A2P, а не про «плохой запрос»", () => {
    expect(describeSendFailure("quo_client", "400:0206400")).toContain("A2P");
  });

  it("без кода провайдера остаётся понятная подпись по нашему коду", () => {
    expect(describeSendFailure("store_no_quo_number")).toBe("У магазина не задан номер отправителя QUO.");
    expect(describeSendFailure("quo_network")).toContain("Сетевая ошибка");
  });

  it("незнакомый код возвращается как есть — молчать о нём хуже", () => {
    expect(describeSendFailure("whatever_new")).toBe("whatever_new");
  });
});
