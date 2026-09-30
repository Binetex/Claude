import { describe, it, expect } from "vitest";
import { planDay, canFit, earliestBy, type PlanJob, type PlanParams } from "./planner";

const h = (hh: number, mm = 0) => hh * 60 + mm;
// Настя: линия с 11:22 (10:00 + разгон 82), маленький 47, большой 64; курьер 24.
const P: PlanParams = { lineStart: h(11, 22), courierMin: 24, prepMin: (big) => (big ? 64 : 47) };
const job = (id: string, deadline: number, extra: Partial<PlanJob> = {}): PlanJob => ({
  id, big: false, deadline, windowFrom: h(11), driveMin: 50, ...extra,
});

describe("planDay — очередь по срокам", () => {
  it("кому нужно раньше — делают первым; время = линия + сборки + курьер + дорога", () => {
    const plan = planDay([job("late", h(21)), job("early", h(13)), job("mid", h(15))], P);
    const byId = Object.fromEntries(plan.items.map((i) => [i.id, i]));
    expect([byId.early.seq, byId.mid.seq, byId.late.seq]).toEqual([1, 2, 3]);
    expect(byId.early.readyAt).toBe(h(11, 22) + 47);
    expect(byId.early.etaAt).toBe(h(11, 22) + 47 + 24 + 50);
    expect(byId.mid.readyAt).toBe(h(11, 22) + 47 * 2);
  });

  it("срок учитывает дорогу: далёкий заказ с тем же сроком делают раньше", () => {
    const plan = planDay([job("near", h(15), { driveMin: 20 }), job("far", h(15), { driveMin: 90 })], P);
    expect(plan.items.find((i) => i.id === "far")!.seq).toBe(1);
  });

  it("раньше начала окна не везут: букет ждёт", () => {
    const plan = planDay([job("evening", h(21), { windowFrom: h(18) })], P);
    expect(plan.items[0].etaAt).toBe(h(18));
  });

  it("опоздание больше 20 минут — риск, до 20 — нет", () => {
    // Готов 11:22 + 47 = 12:09, доставка 12:09 + 24 + 50 = 13:23.
    const ok = planDay([job("a", h(13, 10))], P); // на 13 мин позже срока — в допуске
    expect(ok.items[0].lateMin).toBe(13);
    expect(ok.items[0].risk).toBe(false);
    const late = planDay([job("a", h(12, 30))], P); // на 53 мин позже
    expect(late.items[0].risk).toBe(true);
    expect(late.items[0].lateMin).toBe(53);
  });

  it("готовые и уехавшие букеты в очередь сборки не входят", () => {
    const plan = planDay([job("done", h(13), { fixed: true }), job("next", h(14))], P);
    expect(plan.items.find((i) => i.id === "next")!.seq).toBe(1);
    expect(plan.items.find((i) => i.id === "done")!.seq).toBeNull();
  });

  it("заказ заранее: линия начинается раньше, если иначе ранний заказ не успеть, но не раньше 6:00", () => {
    const early = job("9am", h(9, 30), { windowFrom: h(9) });
    const plan = planDay([early], { ...P, lineStart: h(11, 22), earliestLineStart: h(6) });
    expect(plan.lineStart).toBe(h(9, 30) - 24 - 50 - 47);
    expect(plan.items[0].risk).toBe(false);
  });
});

describe("canFit / earliestBy — влезет ли ещё один", () => {
  const day = [job("a", h(13)), job("b", h(14)), job("c", h(15))];

  it("в свободное вечернее время влезает, остальных не ломает", () => {
    expect(canFit(day, job("new", h(19)), P).ok).toBe(true);
  });

  it("не влезает, если сам не успевает", () => {
    expect(canFit(day, job("new", h(12)), P).ok).toBe(false);
  });

  it("не влезает, если из-за него кто-то уходит в риск", () => {
    // Четвёртый к 13:30 встаёт вторым и выталкивает «c» за 15:00.
    const busy = [job("a", h(13), { priority: true }), job("b", h(14, 30), { priority: true }), job("c", h(15, 5), { priority: true })];
    expect(canFit(busy, job("new", h(13, 30)), P).ok).toBe(false);
  });

  it("самый ранний срок — по получасу, пока не влезет", () => {
    const e = earliestBy(day, { id: "new", big: false, windowFrom: 0, driveMin: 50 }, P);
    expect(e).not.toBeNull();
    // Проверяем тем же заказом, что ищет earliestBy: без начала окна (при равных сроках он встаёт раньше).
    expect(canFit(day, job("new", e!, { windowFrom: 0 }), P).ok).toBe(true);
    expect(canFit(day, job("new", e! - 30, { windowFrom: 0 }), P).ok).toBe(false);
  });

  it("заказ заранее: собрать можно с 6 утра, а доставка — не раньше 8:00 (владелец 30.09.2026)", () => {
    const e = earliestBy([], { id: "new", big: false, windowFrom: 0, driveMin: 30 }, { ...P, earliestLineStart: h(6) });
    expect(e).toBe(h(8));
  });

  it("сегодня раньше 11:00 не обещаем, даже если собрать успеем раньше", () => {
    const e = earliestBy([], { id: "new", big: false, windowFrom: 0, driveMin: 30 }, { ...P, lineStart: h(7) });
    expect(e).toBe(h(11));
  });
});

describe("главный магазин (TheFlow) — всегда первым, остальные — после", () => {
  it("чужой заказ перед опаздывающим заказом TheFlow уходит за него", () => {
    const plan = planDay([job("other", h(13)), job("flow", h(13, 10), { priority: true })], P);
    const byId = Object.fromEntries(plan.items.map((i) => [i.id, i]));
    expect([byId.flow.seq, byId.other.seq]).toEqual([1, 2]);
    expect(byId.flow.risk).toBe(false);
  });

  it("дневной TheFlow первым даже с поздним сроком, между собой — по сроку (владелец 30.09.2026)", () => {
    const plan = planDay([job("other", h(13)), job("flow-late", h(19), { priority: true }), job("flow-early", h(15), { priority: true })], P);
    const byId = Object.fromEntries(plan.items.map((i) => [i.id, i]));
    expect([byId["flow-early"].seq, byId["flow-late"].seq, byId.other.seq]).toEqual([1, 2, 3]);
  });

  it("вечерний TheFlow, которому иначе не успеть, отпихивает дневные заказы других магазинов", () => {
    // Восемь дневных Paradise до вечернего TheFlow: собранный последним, он приехал бы к 19:39 при сроке 19:00.
    const pars = Array.from({ length: 8 }, (_, i) => job(`par-${i}`, h(21), { windowFrom: h(11) }));
    const flow = job("flow-evening", h(19), { priority: true, windowFrom: h(18) });
    const plan = planDay([...pars, flow], P);
    const f = plan.items.find((i) => i.id === "flow-evening")!;
    expect(f.risk).toBe(false);
    // Отпихнул ровно столько, сколько нужно: часть Paradise осталась впереди.
    expect(f.seq).toBeGreaterThan(1);
  });

  it("новый заказ TheFlow Paradise не блокирует: самое раннее — как будто их нет", () => {
    const pars = Array.from({ length: 6 }, (_, i) => job(`par-${i}`, h(15 + (i % 3))));
    const fresh = { id: "new", big: false, windowFrom: 0, driveMin: 50, priority: true };
    expect(earliestBy(pars, fresh, P)).toBe(earliestBy([], fresh, P));
  });

  it("вечерний TheFlow (окно с 17:00) — после дневных заказов других магазинов, но первым среди вечерних", () => {
    const plan = planDay(
      [
        job("flow-evening", h(21), { priority: true, windowFrom: h(18) }),
        job("jf-morning", h(15)),
        job("jf-evening", h(21), { windowFrom: h(18) }),
        job("flow-day", h(19), { priority: true, windowFrom: h(15) }),
      ],
      P
    );
    const byId = Object.fromEntries(plan.items.map((i) => [i.id, i]));
    expect([byId["flow-day"].seq, byId["jf-morning"].seq, byId["flow-evening"].seq, byId["jf-evening"].seq]).toEqual([1, 2, 3, 4]);
  });

  it("опоздание заказа другого магазина новый заказ не останавливает, заказа TheFlow — останавливает", () => {
    const fresh = job("new", h(13, 20));
    expect(canFit([job("b", h(13, 45))], fresh, P).ok).toBe(true);
    expect(canFit([job("b", h(13, 45), { priority: true })], fresh, P).ok).toBe(false);
  });
});
