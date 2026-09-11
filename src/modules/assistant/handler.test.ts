import { describe, it, expect } from "vitest";
import { takeDeferredQueue, describeCall } from "./handler";

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
