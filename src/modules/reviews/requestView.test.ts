import { describe, it, expect } from "vitest";
import { awaitingUs } from "./requestView";

/**
 * «Ход за нами» — то, из-за отсутствия чего владелец терял клиентов: человек отвечал
 * «да, оставлю», ответ уходил в общий поток входящих и пропадал.
 */
const inbound = (id: string) => ({ id, at: "01.01 10:00", inbound: true, kind: "сообщение", text: "yes", failed: false, photos: 0 });
const outbound = (id: string) => ({ id, at: "01.01 09:00", inbound: false, kind: "сообщение", text: "hi", failed: false, photos: 0 });

describe("awaitingUs", () => {
  it("последним написал клиент — ход за нами", () => {
    expect(awaitingUs([outbound("a"), inbound("b")])).toBe(true);
  });

  it("последними написали мы — ждём клиента", () => {
    expect(awaitingUs([inbound("a"), outbound("b")])).toBe(false);
  });

  it("переписки нет — никого не торопим", () => {
    expect(awaitingUs([])).toBe(false);
  });
});
