import { describe, it, expect } from "vitest";
import { takeDeferredQueue } from "./handler";

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
