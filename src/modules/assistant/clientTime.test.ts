import { describe, it, expect } from "vitest";
import { clientNamedTimes, clientOpenAfterTimes, clientNamedDays, clientConfirmed } from "./clientTime";

const hm = (h: number, m = 0) => h * 60 + m;

describe("какое время назвал клиент", () => {
  it("часы с am/pm, 24-часовое время, «by/after/between», диапазоны, полдень", () => {
    expect(clientNamedTimes("3pm please")).toEqual([hm(15)]);
    expect(clientNamedTimes("around 10:30 am")).toEqual([hm(10, 30)]);
    expect(clientNamedTimes("by 2")).toEqual([hm(14)]);
    expect(clientNamedTimes("after five")).toEqual([hm(17)]);
    expect(clientNamedTimes("Ok Tomorrow between 10 and noon will work")).toEqual([hm(10), hm(12)]);
    expect(clientNamedTimes("5-7pm works")).toEqual([hm(17), hm(19)]);
    expect(clientNamedTimes("15:30")).toEqual([hm(15, 30)]);
  });

  it("не время: «as early as possible», «any time», «5 mins out», номер квартиры, телефон", () => {
    // THEFLOW-20876: из этих слов модель вывела «from 3:30», и окно стало 3:30–9 PM.
    expect(clientNamedTimes("No worries, the earliest you can get them there, thanks!\nWill you text when 5 mins out?")).toEqual([]);
    expect(clientNamedTimes("Any time in the morning is preferred")).toEqual([]);
    expect(clientNamedTimes("Can leave with front desk, Unit 404, call 626-388-0192")).toEqual([]);
    expect(clientNamedTimes("we'll be there in 2 hours")).toEqual([]);
  });

  it("открытое «после»: только after/from/past, «afternoon» не в счёт", () => {
    expect(clientOpenAfterTimes("any time after 5")).toEqual([hm(17)]);
    expect(clientOpenAfterTimes("from 3:30 pm")).toEqual([hm(15, 30)]);
    expect(clientOpenAfterTimes("this afternoon please")).toEqual([]);
    expect(clientOpenAfterTimes("by 5")).toEqual([]);
  });
});

describe("какой день назвал клиент", () => {
  it("завтра, день недели, дата — от дня сообщения", () => {
    expect(clientNamedDays("Ok Tomorrow between 10 and noon", "2026-09-29")).toEqual(["2026-09-30"]);
    // FLWBR-91180: в понедельник «until Tuesday morning» — это завтра, вторник.
    expect(clientNamedDays("My wife and I won't be back home until Tuesday morning", "2026-09-28")).toEqual(["2026-09-29"]);
    expect(clientNamedDays("can you do 10/3?", "2026-09-30")).toEqual(["2026-10-03"]);
    expect(clientNamedDays("October 5th please", "2026-09-30")).toEqual(["2026-10-05"]);
    expect(clientNamedDays("the day after tomorrow", "2026-09-30")).toEqual(["2026-10-02"]);
  });

  it("не дата: «another day», «later», «next week»", () => {
    expect(clientNamedDays("maybe another day", "2026-09-30")).toEqual([]);
    expect(clientNamedDays("sometime next week", "2026-09-30")).toEqual([]);
  });
});

describe("обещание модели — только по словам клиента", () => {
  it("THEFLOW-20876: «as early as possible» — окно не трогаем, хоть модель и пообещала 3:30", () => {
    expect(
      clientConfirmed({ text: "No worries, the earliest you can get them there, thanks!\nWill you text when 5 mins out?", messageDay: "2026-09-30", newDate: null, from: hm(15, 30), until: null })
    ).toEqual({ newDate: null, from: null, until: null });
  });

  it("FLWBR-91180: «tomorrow between 10 and noon» — и день, и окно клиента", () => {
    expect(clientConfirmed({ text: "Ok Tomorrow between 10 and noon will work. Thanks R", messageDay: "2026-09-29", newDate: "2026-09-30", from: hm(10), until: hm(12) }))
      .toEqual({ newDate: "2026-09-30", from: hm(10), until: hm(12) });
  });

  it("клиент назвал «до 1», а модель предлагает с 3:30 — это её встречное предложение, не его слова", () => {
    expect(clientConfirmed({ text: "can you do by 1pm?", messageDay: "2026-09-30", newDate: null, from: hm(15, 30), until: null })).toEqual({ newDate: null, from: null, until: null });
  });

  it("«after 5» — с 17:00 до конца дня; «by 2» — до 14:00; «around 5» — 5:00–5:30", () => {
    expect(clientConfirmed({ text: "after 5 please", messageDay: "2026-09-30", newDate: null, from: hm(17), until: null })).toEqual({ newDate: null, from: hm(17), until: null });
    expect(clientConfirmed({ text: "by 2 please", messageDay: "2026-09-30", newDate: null, from: null, until: hm(14) })).toEqual({ newDate: null, from: null, until: hm(14) });
    expect(clientConfirmed({ text: "around 5pm", messageDay: "2026-09-30", newDate: null, from: hm(17), until: hm(17, 30) })).toEqual({ newDate: null, from: hm(17), until: hm(17, 30) });
  });

  it("THEFLOW-20925: «between 5-7» при окне 3–7 — окно клиента 5–7", () => {
    const text = "Yes, can this be delivered between 5-7 instead?";
    expect(clientConfirmed({ text, messageDay: "2026-10-07", newDate: null, from: hm(17), until: hm(19) })).toEqual({ newDate: null, from: hm(17), until: hm(19) });
  });

  it("начало промежутка и «not before» — это «не раньше»: ответ «after 5» двигает начало окна", () => {
    for (const [text, h] of [["Can it be between 5 and 6?", 17], ["5-6 works", 17], ["Please not before 4, I'm at work", 16], ["not until 6pm", 18]] as const) {
      expect(clientConfirmed({ text, messageDay: "2026-10-07", newDate: null, from: hm(h), until: null }), text).toEqual({ newDate: null, from: hm(h), until: null });
    }
  });

  it("«5pm» без «после» — открытое окно до вечера не рисуем", () => {
    expect(clientConfirmed({ text: "5pm", messageDay: "2026-09-30", newDate: null, from: hm(17), until: null })).toEqual({ newDate: null, from: null, until: null });
  });

  it("день модели не тот, что назвал клиент, — день не меняем", () => {
    expect(clientConfirmed({ text: "tomorrow please", messageDay: "2026-09-30", newDate: "2026-10-02", from: null, until: null }).newDate).toBeNull();
    expect(clientConfirmed({ text: "another day please", messageDay: "2026-09-30", newDate: "2026-10-01", from: null, until: null }).newDate).toBeNull();
  });
});
