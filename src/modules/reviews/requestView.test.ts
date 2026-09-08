import { describe, it, expect } from "vitest";
import { awaitingUs } from "./requestView";

/**
 * «Ход за нами» — то, из-за отсутствия чего владелец терял клиентов: человек отвечал
 * «да, оставлю», ответ уходил в общий поток входящих и пропадал.
 *
 * Лента общая с карточкой заказа и приходит НОВЫМИ СВЕРХУ — на этом легко ошибиться, поэтому
 * порядок закреплён тестом.
 */
const inbound = { direction: "INBOUND" };
const outbound = { direction: "OUTBOUND" };

describe("awaitingUs", () => {
  it("последним написал клиент — ход за нами", () => {
    expect(awaitingUs([inbound, outbound])).toBe(true);
  });

  it("последними написали мы — ждём клиента", () => {
    expect(awaitingUs([outbound, inbound])).toBe(false);
  });

  it("переписки нет — никого не торопим", () => {
    expect(awaitingUs([])).toBe(false);
  });
});
