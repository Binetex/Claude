import { describe, it, expect } from "vitest";
import { BurqApiError } from "./client";
import { burqErrorMessage } from "./errorMessage";

/**
 * Ошибка Burq должна говорить, ЧТО делать.
 *
 * История: любой сбой превращался в «Ошибка обращения к Burq. Попробуйте позже.» Эта фраза
 * одинаково описывала три разные ситуации: не заданы ключи (чинится за минуту в настройках),
 * опечатка в номере заказа (чинится вводом), сбой у Burq (не чинится вовсе). Ждать имело смысл
 * только в третьей.
 */
describe("что показать при сбое Burq", () => {
  it("отказ в доступе ведёт к ключам, а не к ожиданию", () => {
    for (const status of [401, 403]) {
      expect(burqErrorMessage(new BurqApiError("nope", status))).toContain("ключи");
    }
  });

  it("несуществующий заказ показывает, что проверить", () => {
    expect(burqErrorMessage(new BurqApiError("not found", 404))).toContain("Burq Order ID");
  });

  it("сбой на стороне Burq прямо говорит, что дело не в нас", () => {
    const msg = burqErrorMessage(new BurqApiError("boom", 503));
    expect(msg).toContain("сбой на их стороне");
  });

  it("ограничение частоты предлагает подождать, а не чинить", () => {
    expect(burqErrorMessage(new BurqApiError("slow down", 429))).toContain("подождать");
  });

  it("прочий отказ показывает код Burq — он точнее любой нашей формулировки", () => {
    const msg = burqErrorMessage(new BurqApiError("Order is already initiated", 400, "order_deletion_prohibited"));
    expect(msg).toContain("order_deletion_prohibited");
    expect(msg).toContain("already initiated");
  });

  it("обрыв связи отличается от отказа: запрос мог и дойти", () => {
    expect(burqErrorMessage(new Error("fetch failed"))).toContain("не ответил");
    expect(burqErrorMessage(new Error("ETIMEDOUT"))).toContain("не ответил");
  });

  it("незнакомая ошибка не притворяется понятной, а ведёт к журналу", () => {
    expect(burqErrorMessage(new Error("что-то своё"))).toContain("системных событиях");
  });
});
