/**
 * «Найти чат и подключить»: кто писал боту — по ответу `getUpdates`. Без сети: fetch подменён.
 *
 * Сторожится то, на чём кнопка подключила бы не тот чат или промолчала бы непонятно: свежий чат
 * первым и один раз, группа узнаётся и по добавлению бота, включённый вебхук (409) и плохой токен
 * объясняются словами.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { chatsFromUpdates } from "./findChatParse";
import { findBotChats } from "./findChat";

const arina = { id: 555001, type: "private", first_name: "Arina", username: "arina_fl" };
const team = { id: -100777, type: "supergroup", title: "Флористы" };

describe("чаты из getUpdates", () => {
  it("свежие первыми, каждый чат один раз, группа — по добавлению бота", () => {
    const chats = chatsFromUpdates([
      { update_id: 1, message: { chat: arina } },
      { update_id: 2, my_chat_member: { chat: team } },
      { update_id: 3, message: { chat: arina } },
    ]);
    expect(chats).toEqual([
      { chatId: "555001", name: "Arina @arina_fl", isGroup: false },
      { chatId: "-100777", name: "Флористы", isGroup: true },
    ]);
  });

  it("обновления без чата пропускаются", () => {
    expect(chatsFromUpdates([{ update_id: 1 }])).toEqual([]);
  });
});

describe("findBotChats", () => {
  afterEach(() => vi.unstubAllGlobals());

  function stub(...responses: { status: number; body: unknown }[]) {
    const fetchMock = vi.fn();
    for (const r of responses) fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(r.body), { status: r.status }));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("находит чат и имя бота; обновления не подтверждает (без offset)", async () => {
    const f = stub({ status: 200, body: { ok: true, result: { username: "arina_bot" } } }, { status: 200, body: { ok: true, result: [{ update_id: 9, message: { chat: arina } }] } });
    expect(await findBotChats("T")).toEqual({ ok: true, botUsername: "arina_bot", chats: [{ chatId: "555001", name: "Arina @arina_fl", isGroup: false }] });
    expect(String(f.mock.calls[1][0])).not.toContain("offset");
  });

  it("включён приём ответов (409) — объясняет, что делать", async () => {
    stub({ status: 200, body: { ok: true, result: {} } }, { status: 409, body: { ok: false } });
    const r = await findBotChats("T");
    expect(r).toMatchObject({ ok: false });
    expect((r as { error: string }).error).toMatch(/приём ответов/);
  });

  it("плохой токен — не идёт за сообщениями", async () => {
    const f = stub({ status: 401, body: { ok: false } });
    expect(await findBotChats("T")).toMatchObject({ ok: false, error: expect.stringMatching(/Токен недействителен/) });
    expect(f).toHaveBeenCalledTimes(1);
  });
});
