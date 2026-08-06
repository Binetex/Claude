import { describe, it, expect } from "vitest";
import {
  buildOrderHalves,
  packOrderColumns,
  packColumnsIntoPages,
  type RecipientInfo,
  type Half,
} from "./packSheets";

const rec = (name: string): RecipientInfo => ({
  recipientName: name,
  recipientPhone: "555",
  addressLine: "1 St",
  apartment: null,
  city: "LA",
  state: null,
  zip: "90001",
});

const nameOf = (h: Half) => (h as Extract<Half, { kind: "recipient" }>).recipient.recipientName;

describe("buildOrderHalves / packOrderColumns — 1 столбец = 1 заказ", () => {
  it("короткая открытка → 1 столбец: верх получатель, низ текст", () => {
    const halves = buildOrderHalves(rec("Sarah"), ["Happy Birthday"], 16);
    const columns = packOrderColumns([halves]);
    expect(columns).toHaveLength(1);
    expect(columns[0].top.kind).toBe("recipient");
    expect(columns[0].bottom).toMatchObject({ kind: "message", body: "Happy Birthday" });
  });

  it("два заказа → два ОТДЕЛЬНЫХ столбца (внутри столбца не смешиваются)", () => {
    const a = buildOrderHalves(rec("A"), ["hi a"], 16);
    const b = buildOrderHalves(rec("B"), ["hi b"], 16);
    const columns = packOrderColumns([a, b]);
    expect(columns).toHaveLength(2);
    expect(nameOf(columns[0].top)).toBe("A");
    expect(nameOf(columns[1].top)).toBe("B");
    // в первом столбце нет данных второго заказа
    expect(columns[0].bottom).toMatchObject({ body: "hi a" });
  });

  it("очень длинная открытка → доп. столбцы ТОЛЬКО с текстом (без повтора получателя)", () => {
    const halves = buildOrderHalves(rec("Amanda"), ["part1", "part2", "part3"], 12);
    const columns = packOrderColumns([halves]);
    expect(columns).toHaveLength(2); // [rec|part1], [part2|part3]
    expect(columns[0].top.kind).toBe("recipient");
    expect(columns[0].bottom).toMatchObject({ kind: "message", body: "part1" });
    // второй столбец — только продолжение текста, получателя нет
    expect(columns[1].top).toMatchObject({ kind: "message", body: "part2" });
    expect(columns[1].bottom).toMatchObject({ kind: "message", body: "part3" });
    expect(columns[1].top.kind).not.toBe("recipient");
  });

  it("заказ без текста открытки → низ пустое поле (пустая message-половина)", () => {
    const halves = buildOrderHalves(rec("Robert"), [], 16);
    const columns = packOrderColumns([halves]);
    expect(columns).toHaveLength(1);
    expect(columns[0].bottom).toMatchObject({ kind: "message", body: "" });
  });

  it("нечётное число половин у заказа → следующий заказ начинается с нового столбца", () => {
    // A: получатель + 2 части = 3 половины → 2 столбца (низ 2-го столбца пустой)
    const a = buildOrderHalves(rec("A"), ["p1", "p2"], 12);
    const b = buildOrderHalves(rec("B"), ["b1"], 16);
    const columns = packOrderColumns([a, b]);
    expect(columns).toHaveLength(3);
    expect(columns[1].bottom.kind).toBe("empty"); // хвост A — пустая нижняя карточка
    expect(nameOf(columns[2].top)).toBe("B"); // B в новом столбце
  });
});

describe("packColumnsIntoPages — 2 столбца на лист (сетка 2×2)", () => {
  it("два заказа помещаются на ОДИН лист: слева первый, справа второй", () => {
    const a = buildOrderHalves(rec("A"), ["hi a"], 16);
    const b = buildOrderHalves(rec("B"), ["hi b"], 16);
    const pages = packColumnsIntoPages(packOrderColumns([a, b]));
    expect(pages).toHaveLength(1);
    expect(nameOf(pages[0].left.top)).toBe("A");
    expect(nameOf(pages[0].right!.top)).toBe("B");
    // столбец не перемешан: текст A остался под получателем A
    expect(pages[0].left.bottom).toMatchObject({ body: "hi a" });
    expect(pages[0].right!.bottom).toMatchObject({ body: "hi b" });
  });

  it("один заказ → правый столбец пустой (лист наполовину чистый)", () => {
    const pages = packColumnsIntoPages(packOrderColumns([buildOrderHalves(rec("A"), ["hi"], 16)]));
    expect(pages).toHaveLength(1);
    expect(pages[0].right).toBeNull();
  });

  it("вдвое меньше листов, чем было при 2 карточках на лист", () => {
    const orders = ["A", "B", "C", "D"].map((n) => buildOrderHalves(rec(n), [`hi ${n}`], 16));
    const columns = packOrderColumns(orders);
    const pages = packColumnsIntoPages(columns);
    expect(columns).toHaveLength(4); // раньше это было бы 4 листа
    expect(pages).toHaveLength(2);
    expect(nameOf(pages[1].left.top)).toBe("C");
    expect(nameOf(pages[1].right!.top)).toBe("D");
  });

  it("порядок столбцов сохраняется, продолжение текста идёт сразу за своим заказом", () => {
    const a = buildOrderHalves(rec("A"), ["p1", "p2"], 12); // 2 столбца
    const b = buildOrderHalves(rec("B"), ["b1"], 16); // 1 столбец
    const pages = packColumnsIntoPages(packOrderColumns([a, b]));
    expect(pages).toHaveLength(2);
    // лист 1 — оба столбца заказа A
    expect(nameOf(pages[0].left.top)).toBe("A");
    expect(pages[0].right!.top).toMatchObject({ kind: "message", body: "p2" });
    // лист 2 — заказ B
    expect(nameOf(pages[1].left.top)).toBe("B");
    expect(pages[1].right).toBeNull();
  });
});

/**
 * Портретная раскладка — та, что была до перехода на 2×2: лист и есть заказ.
 * Проверяется отдельно, потому что от неё зависит, влезет ли записка «на полстраницы».
 */
describe("packColumnsIntoPages — по одному заказу на лист (портрет)", () => {
  it("каждый столбец получает свой лист, правого нет", () => {
    const a = buildOrderHalves(rec("A"), ["hi a"], 16);
    const b = buildOrderHalves(rec("B"), ["hi b"], 16);
    const pages = packColumnsIntoPages(packOrderColumns([a, b]), 1);
    expect(pages).toHaveLength(2);
    expect(nameOf(pages[0].left.top)).toBe("A");
    expect(nameOf(pages[1].left.top)).toBe("B");
    expect(pages.every((p) => p.right === null)).toBe(true);
  });

  it("верх листа — получатель, низ — текст открытки", () => {
    const pages = packColumnsIntoPages(packOrderColumns([buildOrderHalves(rec("A"), ["Поздравляю"], 16)]), 1);
    expect(pages[0].left.top.kind).toBe("recipient");
    expect(pages[0].left.bottom).toMatchObject({ kind: "message", body: "Поздравляю" });
  });

  it("длинный текст добавляет листы того же заказа, а не смешивает заказы", () => {
    const a = buildOrderHalves(rec("A"), ["p1", "p2"], 12); // 2 столбца
    const b = buildOrderHalves(rec("B"), ["b1"], 16);
    const pages = packColumnsIntoPages(packOrderColumns([a, b]), 1);
    expect(pages).toHaveLength(3);
    expect(nameOf(pages[0].left.top)).toBe("A");
    expect(pages[1].left.top).toMatchObject({ kind: "message", body: "p2" }); // продолжение A
    expect(nameOf(pages[2].left.top)).toBe("B");
  });

  it("та же выборка на альбомном листе занимает вдвое меньше листов", () => {
    const orders = ["A", "B", "C", "D"].map((n) => buildOrderHalves(rec(n), [`hi ${n}`], 16));
    const cols = packOrderColumns(orders);
    expect(packColumnsIntoPages(cols, 1)).toHaveLength(4);
    expect(packColumnsIntoPages(cols, 2)).toHaveLength(2);
  });
});
