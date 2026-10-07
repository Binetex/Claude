import { describe, it, expect } from "vitest";
import { takeDeferredQueue, describeCall, plannedEarliest, earliestLabel, lateByPlanNote } from "./handler";

/**
 * Очередь сообщений: человек пишет одну мысль в три приёма, и отвечаем мы на неё один раз.
 * Строка `superseded` остаётся в журнале навсегда, поэтому граница очереди — не время, а
 * ближайшее УЖЕ РАЗОБРАННОЕ сообщение.
 */
const deferred = (id: string) => ({ id, status: "SKIPPED", skipReason: "superseded" });
const answered = (id: string) => ({ id, status: "SENT", skipReason: null });

describe("takeDeferredQueue", () => {
  it("забирает всё, что отложилось, и возвращает в порядке, в котором человек писал", () => {
    // На входе — от свежих к старым, как отдаёт запрос.
    const q = takeDeferredQueue([deferred("c"), deferred("b"), deferred("a")]);
    expect(q.map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("останавливается на разобранном: на те же слова второй раз не отвечаем", () => {
    // b и c уже ушли одним ответом, теперь пришло новое сообщение — берём только d.
    const q = takeDeferredQueue([deferred("d"), answered("c"), deferred("b"), deferred("a")]);
    expect(q.map((r) => r.id)).toEqual(["d"]);
  });

  it("пропуск по другой причине тоже закрывает очередь", () => {
    // Потолок ответов или «спасибо»: это разобранное сообщение, а не отложенное.
    const q = takeDeferredQueue([{ id: "b", status: "SKIPPED", skipReason: "daily_cap" }, deferred("a")]);
    expect(q).toEqual([]);
  });

  it("ничего не отложено — очередь из одного сообщения, как раньше", () => {
    expect(takeDeferredQueue([])).toEqual([]);
    expect(takeDeferredQueue([answered("a")])).toEqual([]);
  });
});

/**
 * Как звонок выглядит для модели. Слушать разговор она не может, но обязана знать, что он был:
 * именно из-за его отсутствия в истории ассистент переспрашивал время доставки после того,
 * как владелец уже всё обсудил с клиентом голосом.
 */
describe("описание звонка в истории для модели", () => {
  it("исходящий разговор: видно, кто кому звонил и сколько это длилось", () => {
    const text = describeCall({ type: "CALL", status: "COMPLETED", direction: "OUTBOUND", durationSeconds: 372 });
    expect(text).toContain("phone call");
    expect(text).toContain("the shop called the customer");
    expect(text).toContain("6 min");
  });

  it("входящий разговор подписан со стороны клиента", () => {
    expect(describeCall({ type: "CALL", status: "COMPLETED", direction: "INBOUND", durationSeconds: 120 }))
      .toContain("customer called the shop");
  });

  it("пропущенный входящий — не разговор, и это видно", () => {
    const text = describeCall({ type: "CALL", status: "MISSED", direction: "INBOUND", durationSeconds: null });
    expect(text).toContain("missed call");
    expect(text).not.toContain("phone call —");
  });

  it("голосовое помечено как непрочитанное: модель не должна делать вид, что прочла", () => {
    expect(describeCall({ type: "VOICEMAIL", status: "RECEIVED", direction: "INBOUND", durationSeconds: 30 }))
      .toContain("cannot read it");
  });

  it("без длительности строка остаётся осмысленной", () => {
    const text = describeCall({ type: "CALL", status: "COMPLETED", direction: "OUTBOUND", durationSeconds: null });
    expect(text).toContain("phone call");
    expect(text).not.toContain("null");
    expect(text).not.toContain("NaN");
  });

  it("короткий разговор округляется до минуты, а не до нуля", () => {
    expect(describeCall({ type: "CALL", status: "COMPLETED", direction: "OUTBOUND", durationSeconds: 20 }))
      .toContain("1 min");
  });

  it("без длинных тире: модель копирует стиль, который видит в истории", () => {
    const all = [
      describeCall({ type: "CALL", status: "COMPLETED", direction: "OUTBOUND", durationSeconds: 300 }),
      describeCall({ type: "CALL", status: "MISSED", direction: "INBOUND", durationSeconds: null }),
      describeCall({ type: "VOICEMAIL", status: "RECEIVED", direction: "INBOUND", durationSeconds: 10 }),
    ].join(" ");
    expect(all).not.toMatch(/[—–]/);
  });
});

/**
 * Время по УЖЕ ПРИНЯТОМУ заказу, каким его видит ИИ: плановое по графику (владелец 05.10.2026,
 * FLWBR-91183 — «по графику очевидно около трёх», а получатель услышал «около 12»).
 */
describe("plannedEarliest", () => {
  const hm = (h: number, m = 0) => h * 60 + m;

  it("FLWBR-91183: окно 11:30–12:30, по графику 15:59 — ИИ видит 16:00, а не 12:00", () => {
    expect(plannedEarliest(hm(15, 59), hm(11, 30), hm(11, 53))).toBe(hm(16));
  });

  it("время по графику как есть: без запаса в два часа и без потолка «начало окна»", () => {
    expect(plannedEarliest(hm(16), hm(15), null)).toBe(hm(16));
    // FLWBR-91180: график 13:35 на окно 10–12 — теперь это честные «около двух».
    expect(plannedEarliest(hm(13, 35), hm(10), hm(8, 50))).toBe(hm(14));
  });

  it("вверх до получаса и не раньше «сейчас» в день доставки", () => {
    expect(plannedEarliest(hm(12, 10), hm(11), hm(9))).toBe(hm(12, 30));
    expect(plannedEarliest(hm(11), hm(11), hm(14, 5))).toBe(hm(14, 30));
  });

  it("не раньше 11 сегодня и 8 заранее — если окно заказа само не начинается раньше", () => {
    expect(plannedEarliest(hm(10), hm(11), hm(9))).toBe(hm(11));
    // Окно «с 10» согласовали люди — порог его не урезает.
    expect(plannedEarliest(hm(10), hm(10), hm(9))).toBe(hm(10));
    expect(plannedEarliest(hm(7), hm(11), null)).toBe(hm(8));
  });

  it("поздно по графику — так и называем; null — только когда день уже кончился", () => {
    expect(plannedEarliest(hm(21, 40), hm(11), hm(15))).toBe(hm(22));
    expect(plannedEarliest(hm(13), hm(10), hm(21, 10))).toBeNull();
  });
});

describe("earliestLabel — раньше 11 модель сама не предлагает", () => {
  it("раньше 11: по умолчанию 11 AM, раннее — только если клиент просит", () => {
    const label = earliestLabel(8 * 60 + 30)!;
    expect(label.startsWith("11")).toBe(true);
    expect(label).toContain("8:30");
    expect(label).toContain("only if the customer asks for earlier");
  });

  it("с 11 и позже, «не успеть» и «не знаем» — как было", () => {
    expect(earliestLabel(14 * 60)).not.toContain("only if");
    expect(earliestLabel(null)).toBeNull();
    expect(earliestLabel(undefined)).toBeUndefined();
  });
});

describe("lateByPlanNote — опоздание за окно объявляют люди, а не ИИ", () => {
  it("FLWBR-91184: окно 11–4, по графику 8 вечера — черновик человеку с предупреждением", () => {
    const note = lateByPlanNote({ windowFrom: 660, windowTo: 960, deliveryWindow: "11:00 - 16:00" }, 1200);
    expect(note).toContain("не успевает в окно");
    expect(note).toContain("до 16:00");
    expect(note).toContain("~20:00");
  });

  it("успеваем в окно (и ровно к его концу) — ИИ отвечает как обычно", () => {
    expect(lateByPlanNote({ windowFrom: 660, windowTo: 1020 }, 960)).toBeNull();
    expect(lateByPlanNote({ windowFrom: 660, windowTo: 1020 }, 1020)).toBeNull();
  });

  it("окна нет или время по графику неизвестно — предупреждать не о чем", () => {
    expect(lateByPlanNote({ windowFrom: null, windowTo: null, deliveryWindow: null }, 1200)).toBeNull();
    expect(lateByPlanNote({ windowFrom: 660, windowTo: 960 }, null)).toBeNull();
    expect(lateByPlanNote({ windowFrom: 660, windowTo: 960 }, undefined)).toBeNull();
  });
});
