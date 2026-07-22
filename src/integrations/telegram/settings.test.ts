/**
 * Правила безопасности настроек Telegram — то, что нельзя проверить глазами в UI:
 *  - пустой токен не стирает существующий;
 *  - изменение конфигурации сбрасывает подтверждение (нельзя оставить включённым непроверенное);
 *  - включить без успешной проверки невозможно.
 * Prisma замокан: проверяем именно логику, а не БД (её покрывает integration-тест).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/crypto/secretBox", () => ({
  encryptSecret: (s: string) => `enc(${s})`,
  decryptSecret: (s: string) => {
    // Как настоящий secretBox: на неверном шифртексте бросает.
    const m = /^enc\((.*)\)$/.exec(s);
    if (!m) throw new Error("bad ciphertext");
    return m[1];
  },
  isCredentialCryptoConfigured: () => true,
}));

import { saveTelegramSettings, setTelegramEnabled, resolveTelegramSettings, loadTelegramSettingsView } from "./settings";

type Row = Record<string, unknown> | null;
let row: Row;
let lastUpdate: Record<string, unknown> | null;

const prisma = {
  telegramSettings: {
    findUnique: async () => row,
    upsert: async ({ update }: { update: Record<string, unknown> }) => { lastUpdate = update; return {}; },
    update: async ({ data }: { data: Record<string, unknown> }) => { lastUpdate = data; return {}; },
  },
// eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

beforeEach(() => { row = null; lastUpdate = null; });

describe("сохранение", () => {
  it("пустой токен НЕ стирает существующий", async () => {
    row = { botTokenEncrypted: "enc(old)", ownerChatId: "-1", floristsChatId: "-2" };
    await saveTelegramSettings(prisma, { botToken: "", ownerChatId: "-1", floristsChatId: "-2" });
    expect(lastUpdate).not.toHaveProperty("botTokenEncrypted");
  });

  it("непустой токен шифруется перед записью", async () => {
    await saveTelegramSettings(prisma, { botToken: "123:AA", ownerChatId: "", floristsChatId: "" });
    expect(lastUpdate!.botTokenEncrypted).toBe("enc(123:AA)");
  });

  it("смена chat id сбрасывает проверку и выключает уведомления", async () => {
    row = { botTokenEncrypted: "enc(old)", ownerChatId: "-1", floristsChatId: "-2", enabled: true, verifiedAt: new Date() };
    await saveTelegramSettings(prisma, { botToken: "", ownerChatId: "-999", floristsChatId: "-2" });
    expect(lastUpdate).toMatchObject({ verifiedAt: null, enabled: false });
  });

  it("сохранение без изменений не сбрасывает подтверждение", async () => {
    row = { botTokenEncrypted: "enc(old)", ownerChatId: "-1", floristsChatId: "-2", enabled: true, verifiedAt: new Date() };
    await saveTelegramSettings(prisma, { botToken: "", ownerChatId: "-1", floristsChatId: "-2" });
    expect(lastUpdate).not.toHaveProperty("verifiedAt");
  });
});

describe("включение", () => {
  it("без успешной проверки включить нельзя", async () => {
    row = { botTokenEncrypted: "enc(t)", verifiedAt: null };
    expect(await setTelegramEnabled(prisma, true)).toMatchObject({ error: expect.stringContaining("проверку") });
  });

  it("после проверки включается", async () => {
    row = { botTokenEncrypted: "enc(t)", verifiedAt: new Date() };
    expect(await setTelegramEnabled(prisma, true)).toEqual({ ok: true });
  });

  it("выключить можно всегда — это аварийный выключатель", async () => {
    row = { botTokenEncrypted: "enc(t)", verifiedAt: null, enabled: true };
    expect(await setTelegramEnabled(prisma, false)).toEqual({ ok: true });
  });
});

describe("выдача наружу", () => {
  it("в UI уходит только признак «настроен», без токена", async () => {
    row = { botTokenEncrypted: "enc(secret-token)", ownerChatId: "-1", enabled: true, verifiedAt: new Date(), botUsername: "flor_bot" };
    const view = await loadTelegramSettingsView(prisma);
    expect(view.botTokenConfigured).toBe(true);
    expect(JSON.stringify(view)).not.toContain("secret-token");
  });

  it("на сервере токен расшифровывается для отправки", async () => {
    row = { botTokenEncrypted: "enc(secret-token)", ownerChatId: "-1", floristsChatId: "-2", enabled: true };
    expect((await resolveTelegramSettings(prisma)).botToken).toBe("secret-token");
  });

  it("повреждённый шифртекст (сменили ключ) → токен ненастроен, но приложение не падает", async () => {
    row = { botTokenEncrypted: "не-шифртекст", enabled: true };
    await expect(resolveTelegramSettings(prisma)).resolves.toMatchObject({ botToken: null });
  });
});
