import { describe, it, expect } from "vitest";
import { buildOrderHalves, packOrderSheets, type RecipientInfo, type Half } from "./packSheets";

const rec = (name: string): RecipientInfo => ({
  recipientName: name,
  recipientPhone: "555",
  addressLine: "1 St",
  apartment: null,
  city: "LA",
  state: null,
  zip: "90001",
});

describe("buildOrderHalves / packOrderSheets — 1 лист = 1 заказ", () => {
  it("короткая открытка → 1 лист: верх получатель, низ текст", () => {
    const halves = buildOrderHalves(rec("Sarah"), ["Happy Birthday"], 16);
    const sheets = packOrderSheets([halves]);
    expect(sheets).toHaveLength(1);
    expect(sheets[0].top.kind).toBe("recipient");
    expect(sheets[0].bottom).toMatchObject({ kind: "message", body: "Happy Birthday" });
  });

  it("два заказа → два ОТДЕЛЬНЫХ листа (не смешиваются)", () => {
    const a = buildOrderHalves(rec("A"), ["hi a"], 16);
    const b = buildOrderHalves(rec("B"), ["hi b"], 16);
    const sheets = packOrderSheets([a, b]);
    expect(sheets).toHaveLength(2);
    expect((sheets[0].top as Extract<Half, { kind: "recipient" }>).recipient.recipientName).toBe("A");
    expect((sheets[1].top as Extract<Half, { kind: "recipient" }>).recipient.recipientName).toBe("B");
    // на первом листе нет данных второго заказа
    expect(sheets[0].bottom).toMatchObject({ body: "hi a" });
  });

  it("очень длинная открытка → доп. листы ТОЛЬКО с текстом (без повтора получателя/заголовков)", () => {
    const halves = buildOrderHalves(rec("Amanda"), ["part1", "part2", "part3"], 12);
    const sheets = packOrderSheets([halves]);
    expect(sheets).toHaveLength(2); // [rec|part1], [part2|part3]
    expect(sheets[0].top.kind).toBe("recipient");
    expect(sheets[0].bottom).toMatchObject({ kind: "message", body: "part1" });
    // второй лист — только продолжение текста, получателя нет
    expect(sheets[1].top).toMatchObject({ kind: "message", body: "part2" });
    expect(sheets[1].bottom).toMatchObject({ kind: "message", body: "part3" });
    expect(sheets[1].top.kind).not.toBe("recipient");
  });

  it("заказ без текста открытки → низ пустое поле (пустая message-половина)", () => {
    const halves = buildOrderHalves(rec("Robert"), [], 16);
    const sheets = packOrderSheets([halves]);
    expect(sheets).toHaveLength(1);
    expect(sheets[0].bottom).toMatchObject({ kind: "message", body: "" });
  });

  it("нечётное число половин у заказа → следующий заказ начинается с нового листа", () => {
    // A: получатель + 2 части = 3 половины → 2 листа (низ 2-го листа пустой)
    const a = buildOrderHalves(rec("A"), ["p1", "p2"], 12);
    const b = buildOrderHalves(rec("B"), ["b1"], 16);
    const sheets = packOrderSheets([a, b]);
    expect(sheets).toHaveLength(3);
    expect(sheets[1].bottom.kind).toBe("empty"); // хвост A — пустая нижняя половина
    expect((sheets[2].top as Extract<Half, { kind: "recipient" }>).recipient.recipientName).toBe("B"); // B на новом листе
  });
});
