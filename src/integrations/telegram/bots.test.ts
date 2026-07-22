/**
 * Правила безопасности персональных ботов — то, что нельзя проверить глазами в UI:
 *  - пустой токен не стирает существующий;
 *  - изменение токена или чата сбрасывает проверку (нельзя оставить включённым непроверенное);
 *  - включить без успешной проверки невозможно;
 *  - токен не утекает в список для UI;
 *  - повреждённый шифртекст не роняет приложение.
 * Prisma замокан: проверяем логику, БД покрыта integration-тестом.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/crypto/secretBox", () => ({
  encryptSecret: (s: string) => `enc(${s})`,
  decryptSecret: (s: string) => {
    const m = /^enc\((.*)\)$/.exec(s);
    if (!m) throw new Error("bad ciphertext"); // как настоящий secretBox
    return m[1];
  },
  isCredentialCryptoConfigured: () => true,
}));

import { upsertBot, setBotEnabled, resolveFloristBot, resolveOwnerBot, listBots } from "./bots";

type Row = Record<string, unknown> | null;
let unique: Row;
let first: Row;
let many: Record<string, unknown>[];
let lastUpdate: Record<string, unknown> | null;
let lastCreate: Record<string, unknown> | null;

const prisma = {
  telegramBot: {
    findUnique: async () => unique,
    findFirst: async () => first,
    findMany: async () => many,
    update: async ({ data }: { data: Record<string, unknown> }) => { lastUpdate = data; return {}; },
    create: async ({ data }: { data: Record<string, unknown> }) => { lastCreate = data; return { id: "new" }; },
  },
// eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

const bot = (over: Record<string, unknown> = {}) => ({
  id: "b1", label: "Наташа", purpose: "FLORIST", tokenEncrypted: "enc(tok)", chatId: "123",
  enabled: true, verifiedAt: new Date(), botUsername: "n_bot", lastErrorSafe: null, floristId: "f1", ...over,
});

beforeEach(() => { unique = null; first = null; many = []; lastUpdate = null; lastCreate = null; });

describe("сохранение бота", () => {
  it("пустой токен НЕ стирает существующий", async () => {
    unique = bot();
    await upsertBot(prisma, { purpose: "FLORIST", floristId: "f1", label: "Наташа", token: "", chatId: "123" });
    expect(lastUpdate).not.toHaveProperty("tokenEncrypted");
  });

  it("новый токен шифруется", async () => {
    unique = bot();
    await upsertBot(prisma, { purpose: "FLORIST", floristId: "f1", label: "Наташа", token: "999:BB", chatId: "123" });
    expect(lastUpdate!.tokenEncrypted).toBe("enc(999:BB)");
  });

  it("смена чата сбрасывает проверку и выключает бота", async () => {
    unique = bot();
    await upsertBot(prisma, { purpose: "FLORIST", floristId: "f1", label: "Наташа", token: "", chatId: "777" });
    expect(lastUpdate).toMatchObject({ verifiedAt: null, enabled: false });
  });

  it("сохранение без изменений проверку не сбрасывает", async () => {
    unique = bot();
    await upsertBot(prisma, { purpose: "FLORIST", floristId: "f1", label: "Наташа", token: "", chatId: "123" });
    expect(lastUpdate).not.toHaveProperty("verifiedAt");
  });

  it("бот флориста создаётся с привязкой к нему", async () => {
    await upsertBot(prisma, { purpose: "FLORIST", floristId: "f9", label: "Пётр", token: "1:A", chatId: "55" });
    expect(lastCreate).toMatchObject({ floristId: "f9", purpose: "FLORIST" });
  });
});

describe("включение", () => {
  it("без проверки включить нельзя", async () => {
    unique = { verifiedAt: null };
    expect(await setBotEnabled(prisma, "b1", true)).toMatchObject({ error: expect.stringContaining("проверку") });
  });

  it("после проверки включается", async () => {
    unique = { verifiedAt: new Date() };
    expect(await setBotEnabled(prisma, "b1", true)).toEqual({ ok: true });
  });

  it("выключить можно всегда", async () => {
    unique = { verifiedAt: null };
    expect(await setBotEnabled(prisma, "b1", false)).toEqual({ ok: true });
  });
});

describe("резолв бота для отправки", () => {
  it("настроенный бот флориста отдаёт расшифрованный токен", async () => {
    unique = bot();
    expect(await resolveFloristBot(prisma, "f1")).toEqual({ bot: { id: "b1", token: "tok", chatId: "123", label: "Наташа" } });
  });

  it("у флориста нет бота → skip no_bot (уведомление тихо пропускается)", async () => {
    unique = null;
    expect(await resolveFloristBot(prisma, "f1")).toEqual({ skip: "no_bot" });
  });

  it("бот выключен → skip bot_disabled", async () => {
    unique = bot({ enabled: false });
    expect(await resolveFloristBot(prisma, "f1")).toEqual({ skip: "bot_disabled" });
  });

  it("нет чата → skip no_chat", async () => {
    unique = bot({ chatId: "  " });
    expect(await resolveFloristBot(prisma, "f1")).toEqual({ skip: "no_chat" });
  });

  it("повреждённый шифртекст → skip, приложение не падает", async () => {
    unique = bot({ tokenEncrypted: "мусор" });
    expect(await resolveFloristBot(prisma, "f1")).toEqual({ skip: "bad_token_ciphertext" });
  });

  it("бот владельца берётся по purpose", async () => {
    first = bot({ purpose: "OWNER", floristId: null, label: "Владелец" });
    expect(await resolveOwnerBot(prisma)).toMatchObject({ bot: { label: "Владелец" } });
  });
});

describe("список для UI", () => {
  it("токен наружу не отдаётся — только признак «настроен»", async () => {
    many = [{ ...bot({ tokenEncrypted: "enc(секретный-токен)" }), florist: { user: { name: "Наташа" } } }];
    const rows = await listBots(prisma);
    expect(rows[0].tokenConfigured).toBe(true);
    expect(JSON.stringify(rows)).not.toContain("секретный-токен");
    expect(JSON.stringify(rows)).not.toContain("enc(");
  });
});
