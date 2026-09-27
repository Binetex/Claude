import { describe, it, expect } from "vitest";
import { wantedRange, adjustForNow, earliestToday, orderPoints, windowIsMorning, wishIsMorning, isMorningOrder, readyTimeWishes, morningVerdict, parseTimes } from "./morning";

describe("orderPoints — работа по цене букета", () => {
  it("маленький 1, большой 2, добавки не считаются", () => {
    expect(orderPoints([{ price: 195, quantity: 1 }])).toBe(1);
    expect(orderPoints([{ price: 325, quantity: 1 }])).toBe(2);
    expect(orderPoints([{ price: 250, quantity: 1 }])).toBe(2);
    // Реальный заказ 22.09: $305 + $185 + ваза.
    expect(orderPoints([{ price: 305, quantity: 1 }, { price: 185, quantity: 1 }, { price: 25, quantity: 1 }])).toBe(3);
    expect(orderPoints([{ price: 150, quantity: 2 }])).toBe(2);
  });

  it("заказ без букетов (ручной, без состава) — один маленький", () => {
    expect(orderPoints([])).toBe(1);
    expect(orderPoints([{ price: 12, quantity: 1 }])).toBe(1);
  });
});

describe("окна из шести магазинов", () => {
  it("разбирает часы в минутах", () => {
    expect(parseTimes("11:00 - 15:00")).toEqual([660, 900]);
    expect(parseTimes("11:00 AM - 4:00 PM")).toEqual([660, 960]);
    expect(parseTimes("4.30 - 5pm")).toEqual([990, 1020]);
    expect(parseTimes("11 - 3pm")).toEqual([660, 900]);
  });

  it("утро — окно, которое кончается к 15:00", () => {
    for (const w of ["11:00 - 15:00", "09:00 - 15:00", "11:00 - 13:00", "2pm", "Before 3PM", "10.30-11.00 AM "]) {
      expect(windowIsMorning(w), w).toBe(true);
    }
  });

  it("окно на весь день и дневные — не утро", () => {
    for (const w of ["11:30 AM - 5:00 PM", "11:00 AM - 4:00 PM", "15:00 - 19:00", "18:00 - 21:00", "15:05 - 18:00", "4.30 - 5pm", "5 - 5.30 PM", "до 5 вечера ", "—", "", null]) {
      expect(windowIsMorning(w), String(w)).toBe(false);
    }
  });
});

describe("пожелания клиента из заметки", () => {
  it("утренние", () => {
    for (const w of ["by noon", "11:00 am", "between 11:30 and 12:30", "available until about 1:40pm, leaving at 1:40", "12 pm", "by 3pm today", "around 2pm"]) {
      expect(wishIsMorning(w), w).toBe(true);
    }
  });

  it("не утренние", () => {
    for (const w of ["after 3.30 pm", "any time today", "anytime is fine", "4-5pm today", "around 7 PM", "6 PM", "business closes at 6pm", "any time during the 3 PM to 7 PM window"]) {
      expect(wishIsMorning(w), w).toBe(false);
    }
  });

  it("берётся последнее пожелание: клиент передумал с утра на вечер", () => {
    const note = "23.09, 08:04 · Клиент (SMS): готов принять 6 PM\n———\n19.09, 10:39 · Клиент (SMS): готов принять around 2pm";
    expect(readyTimeWishes(note)).toEqual(["6 PM", "around 2pm"]);
    expect(isMorningOrder({ window: "5 - 5.30 PM", customerNote: note })).toBe(false);
  });

  it("окно на весь день, но клиент просил к полудню — утренний", () => {
    expect(isMorningOrder({ window: "11:30 AM - 5:00 PM", customerNote: "23.09, 07:28 · Клиент (SMS): готов принять by noon" })).toBe(true);
  });
});

describe("morningVerdict", () => {
  it("у флориста пусто и букет маленький — первым, к полудню", () => {
    expect(morningVerdict({ taken: 0, own: 1, capacity: 4, closed: false })).toBe("FIRST");
  });

  it("большой букет первым к полудню не обещаем", () => {
    expect(morningVerdict({ taken: 0, own: 2, capacity: 4, closed: false })).toBe("AVAILABLE");
  });

  it("место есть — утро, но не к полудню", () => {
    expect(morningVerdict({ taken: 2, own: 1, capacity: 4, closed: false })).toBe("AVAILABLE");
    expect(morningVerdict({ taken: 3, own: 1, capacity: 4, closed: false })).toBe("AVAILABLE");
  });

  it("не влезает или утро закрыто — занято", () => {
    expect(morningVerdict({ taken: 4, own: 1, capacity: 4, closed: false })).toBe("FULL");
    expect(morningVerdict({ taken: 3, own: 2, capacity: 4, closed: false })).toBe("FULL");
    expect(morningVerdict({ taken: 0, own: 1, capacity: 4, closed: true })).toBe("FULL");
  });
});

describe("adjustForNow — день в день нужно время на сборку и дорогу", () => {
  it("не сегодня — вердикт как есть", () => {
    expect(adjustForNow("FIRST", false, 17 * 60)).toBe("FIRST");
  });
  it("рано утром — как есть", () => {
    expect(adjustForNow("FIRST", true, 9 * 60)).toBe("FIRST");
  });
  it("с 10 утра к полудню уже не успеть", () => {
    expect(earliestToday(10 * 60)).toBe(12 * 60 + 30);
    expect(adjustForNow("FIRST", true, 10 * 60 + 5)).toBe("AVAILABLE");
  });
  it("после 12:30 утро сегодня упущено, даже если у флориста пусто", () => {
    expect(adjustForNow("AVAILABLE", true, 12 * 60 + 30)).toBe("AVAILABLE");
    expect(adjustForNow("FIRST", true, 12 * 60 + 31)).toBe("FULL");
  });
  it("самое раннее время округляется вверх до получаса", () => {
    expect(earliestToday(13 * 60 + 10)).toBe(16 * 60);
  });
});

describe("перенос словами освобождает утро", () => {
  it("клиент попросил после 15:00 — утро не занято, хотя окно утреннее", () => {
    for (const w of ["6 PM", "after 5pm", "4-5pm today", "around 7 PM", "after 3.30 pm"]) {
      expect(isMorningOrder({ window: "11:00 - 15:00", customerNote: `27.09, 09:00 · Клиент (SMS): готов принять ${w}` }), w).toBe(false);
    }
  });
  it("«any time» и «до 6» переносом не считаются", () => {
    for (const w of ["any time today", "business closes at 6pm", "until 6pm", "anytime is fine"]) {
      expect(isMorningOrder({ window: "11:00 - 15:00", customerNote: `27.09, 09:00 · Клиент (SMS): готов принять ${w}` }), w).toBe(true);
    }
  });
  it("перенесли обратно на утро — снова утро", () => {
    const note = "27.09, 10:00 · Клиент (SMS): готов принять by noon\n———\n27.09, 09:00 · Клиент (SMS): готов принять 6 PM";
    expect(isMorningOrder({ window: "11:00 - 15:00", customerNote: note })).toBe(true);
  });
});

describe("wantedRange — когда клиент хотел", () => {
  const h = (x: number) => `${Math.floor(x / 60)}:${String(x % 60).padStart(2, "0")}`;
  const r = (w: string | null, wish: string | null) => {
    const v = wantedRange(w, wish);
    return v && `${h(v.from)}-${h(v.to)}`;
  };
  it("по окну, если пожелания нет", () => {
    expect(r("11:00 - 15:00", null)).toBe("11:00-15:00");
  });
  it("по пожеланию клиента", () => {
    expect(r("11:00 - 15:00", "between 11:30 and 12:30")).toBe("11:30-12:30");
    expect(r("11:00 - 15:00", "by noon")).toBe("11:00-12:00");
    expect(r("11:00 - 15:00", "available until about 1:40pm, leaving at 1:40")).toBe("11:00-13:40");
    expect(r("11:00 - 15:00", "12 pm")).toBe("11:30-12:30");
    expect(r("11:30 AM - 5:00 PM", "after 3.30 pm")).toBe("15:30-17:00");
    expect(r("15:00 - 19:00", "4-5pm today")).toBe("16:00-17:00");
  });
  it("«any time» — по окну", () => {
    expect(r("11:00 - 15:00", "any time today")).toBe("11:00-15:00");
  });
});
