import { describe, it, expect } from "vitest";
import {
  buildCourierNoteMessages,
  nextCourierNote,
  namesTime,
  numbersBacked,
  retryAfterRejection,
  teamNoteForCourier,
  validateCourierNote,
  type CourierNoteInput,
} from "./extract";

/**
 * Инструкцию курьеру пишет модель, а читает живой курьер у ворот. Инструкция модели — не
 * гарантия, поэтому здесь закреплены проверки КОДА: что бы модель ни вернула, курьер не получит
 * русского текста, выдуманного кода двери и простыни на полэкрана, а вчерашний код не сотрётся.
 */
const json = (note: string) => JSON.stringify({ note });

describe("числа в инструкции — только из слов клиента", () => {
  it("код, записанный через дефисы или с решёткой, засчитан", () => {
    expect(numbersBacked("Gate code 3262", "front gate is on hollywood blvd gate code is 3-2-6-2")).toBe(true);
    expect(numbersBacked("Gate code #0711", "Gate code is #0711")).toBe(true);
    expect(numbersBacked("Leave at unit 3, 4th floor", "leave it at the front door of Unit 3 on the 4th floor")).toBe(true);
  });

  it("выдуманная или переставленная цифра — нет", () => {
    expect(numbersBacked("Gate code 3263", "gate code is 3-2-6-2")).toBe(false);
    expect(numbersBacked("Gate code 1408", "please leave at the door")).toBe(false);
  });

  it("телефон в любом написании засчитан", () => {
    expect(numbersBacked("Text 747-283-7124 on arrival", "notify this number +1 (747) 283-7124")).toBe(true);
    expect(numbersBacked("Call +1 (747) 283-7124", "notify this number +1 (747) 283-7124")).toBe(true);
  });

  it("код через дефисы в ответе — то же число, что в источнике", () => {
    expect(numbersBacked("Gate code 3-2-6-2", "gate code is 3-2-6-2")).toBe(true);
  });

  it("короткое число должно совпасть целиком: «2» внутри «205» не считается", () => {
    expect(numbersBacked("Unit 205, 2nd floor", "1046 princeston dr | 205")).toBe(false);
    expect(numbersBacked("Unit 205, 2nd floor", "unit 205 on the 2nd floor")).toBe(true);
  });

  it("кусок чужого числа — не код: телефон, номер дома, номер заказа, числа из разных сообщений", () => {
    expect(numbersBacked("Gate code 5550", "call me at 818-555-0199")).toBe(false);
    expect(numbersBacked("Call box 2345", "12345 Ventura Blvd")).toBe(false);
    expect(numbersBacked("Gate code 314", "Apt 3\n14 roses")).toBe(false);
    expect(numbersBacked("Code 2086", "order THEFLOW-20861")).toBe(false);
  });

  it("числа через пробел в ответе — разные числа", () => {
    expect(numbersBacked("Call box 302 2nd floor", "#302 for call box, 2nd floor")).toBe(true);
  });
});

describe("проверка ответа модели", () => {
  const sources = "The gate code is C123 please leave in front of apartment F upstairs";

  it("нормальная инструкция проходит, кавычки и тире упрощаются", () => {
    const v = validateCourierNote(json("Gate code C123 — leave at apartment F’s door upstairs."), sources);
    expect(v).toEqual({ ok: true, note: "Gate code C123, leave at apartment F's door upstairs." });
  });

  it("пустая — «курьеру ничего», это не ошибка", () => {
    expect(validateCourierNote(json(""), sources)).toEqual({ ok: true, note: "" });
  });

  it("русский текст курьеру не уходит никогда", () => {
    expect(validateCourierNote(json("Код C123, оставить у двери"), sources)).toEqual({ ok: false, reason: "cyrillic" });
  });

  it("выдуманный код — отказ", () => {
    expect(validateCourierNote(json("Gate code C124."), sources)).toEqual({ ok: false, reason: "unbacked_number" });
  });

  it("время — отказ: оно у курьера уже есть, а строка «after 2» пережила бы перенос окна", () => {
    expect(validateCourierNote(json("After 2. Gate code C123."), `${sources}, home after 2`)).toEqual({ ok: false, reason: "time" });
    expect(validateCourierNote(json("Gate code C123. Leave at door in the evening."), sources)).toEqual({ ok: false, reason: "time" });
  });

  it("слишком длинная — отказ", () => {
    expect(validateCourierNote(json("Leave at the door. ".repeat(20)), sources)).toEqual({ ok: false, reason: "too_long" });
  });

  it("не JSON или без поля — отказ", () => {
    expect(validateCourierNote("Gate code C123", sources)).toEqual({ ok: false, reason: "bad_json" });
    expect(validateCourierNote(JSON.stringify({ text: "x" }), sources)).toEqual({ ok: false, reason: "bad_json" });
  });

  it("«нового нет» — поле не трогаем, даже если модель вернула текст", () => {
    expect(validateCourierNote(JSON.stringify({ changed: false, note: "Gate code C123." }), sources)).toEqual({ ok: true, note: "" });
    expect(validateCourierNote(JSON.stringify({ changed: true, note: "Gate code C123." }), sources)).toEqual({ ok: true, note: "Gate code C123." });
  });

  it("на повторе модели объясняют, что не так", () => {
    expect(retryAfterRejection("unbacked_number")).toContain("number that is not in the sources");
  });

  it("ответ в ```json``` разбирается", () => {
    expect(validateCourierNote("```json\n" + json("Leave at front door.") + "\n```", sources)).toEqual({ ok: true, note: "Leave at front door." });
  });
});

describe("время в инструкции", () => {
  it("часы, «после N», утро и вечер — время", () => {
    for (const t of ["Deliver by 3pm", "Home at 4:30", "after 2", "around 12", "Leave in the morning", "tonight only"]) expect(namesTime(t)).toBe(true);
  });

  it("квартира, этаж, минуты и «никого нет» — не время", () => {
    for (const t of ["Leave at 7", "Unit 302, 4th floor", "Call 10 minutes before arriving", "If no one is home, leave at door", "Text 30 min before arrival"]) {
      expect(namesTime(t)).toBe(false);
    }
  });
});

describe("что окажется в поле", () => {
  it("пустой ответ модели НЕ стирает вчерашнюю инструкцию", () => {
    expect(nextCourierNote("Gate code #0711.", false, "", 500)).toBeNull();
  });

  it("то же самое другими пробелами и знаками — без перезаписи (и без пересоздания черновика Burq)", () => {
    expect(nextCourierNote("Gate code #0711. Leave at door.", false, "gate code #0711, leave at door", 500)).toBeNull();
  });

  it("свою прошлую инструкцию ИИ заменяет целиком", () => {
    expect(nextCourierNote("Leave at door.", false, "Gate code #0711. Leave at door.", 500)).toBe("Gate code #0711. Leave at door.");
  });

  it("инструкцию человека не переписывает — дописывает строкой ниже", () => {
    expect(nextCourierNote("Ring twice", true, "Gate code #0711.", 500)).toBe("Ring twice\nGate code #0711.");
  });

  it("то, что человек уже написал, второй раз не дописывается", () => {
    expect(nextCourierNote("Gate code #0711, ring twice", true, "Gate code #0711", 500)).toBeNull();
  });

  it("дописка, не влезающая в поле, не пишется", () => {
    expect(nextCourierNote("x".repeat(490), true, "Gate code #0711.", 500)).toBeNull();
  });
});

describe("заметка команды для модели", () => {
  it("русские пометки и строки ИИ вырезаются, английские слова клиента остаются", () => {
    const note =
      "04.10, 10:06 · Клиент (SMS): готов принять after 12 ——— частный дом, отправлять можно\nGate code #2826 leave outside the door. Точно до 3х дня (истеричка)";
    expect(teamNoteForCourier(note)).toBe("Gate code #2826 leave outside the door.");
  });

  it("только русское — пусто, модель не зовём", () => {
    expect(teamNoteForCourier("ПРОСИТ КАК МОЖНО РАНЬШЕ")).toBe("");
  });
});

describe("запрос к модели", () => {
  const base: CourierNoteInput = {
    checkoutInstructions: "Gate code is #0711",
    teamNote: "Точно до 3х дня",
    messages: [
      { from: "shop", text: "Hi! When is a good time to deliver today?" },
      { from: "recipient", text: "after 2, code 1408 at the call box" },
    ],
    addressLine: "123 Main St",
    apartment: "302",
    current: "",
    currentByHuman: false,
  };

  it("слова клиента и заметка команды помечены как данные, а не инструкции модели", () => {
    const user = buildCourierNoteMessages(base)[1].content;
    expect(user).toContain("<client_text>\nGate code is #0711\n</client_text>");
    expect(user).toContain("<team_note>\nТочно до 3х дня\n</team_note>");
    expect(user).toContain("[recipient] after 2, code 1408 at the call box");
    expect(user).toContain("unit: 302");
  });

  it("по своей прошлой инструкции модель сначала отвечает, появилось ли новое", () => {
    const user = buildCourierNoteMessages({ ...base, current: "Gate code #0711." })[1].content;
    expect(user).toContain('{"changed": false, "note": ""}');
    expect(user).toContain("CURRENT NOTE: Gate code #0711.");
  });

  it("инструкцию человека модель не переписывает — просят только дописку", () => {
    const user = buildCourierNoteMessages({ ...base, current: "Ring twice", currentByHuman: true })[1].content;
    expect(user).toContain("with ONLY facts it does not contain yet");
  });
});
