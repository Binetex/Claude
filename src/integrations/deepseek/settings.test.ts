import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/integrations/deepseek/config", () => ({ getDeepseekConfig: () => envCfg.value }));
vi.mock("@/lib/crypto/secretBox", () => ({
  encryptSecret: (s: string) => `enc(${s})`,
  decryptSecret: (s: string) => {
    if (!s.startsWith("enc(")) throw new Error("другой ключ шифрования");
    return s.slice(4, -1);
  },
  maskSecret: (s: string) => "*".repeat(8) + s.slice(-4),
}));

const envCfg: { value: { apiKey: string; baseUrl: string; model: string } | null } = { value: null };
const row: { value: Record<string, unknown> | null } = { value: null };
const prisma = {
  aiAssistantSettings: {
    findUnique: async () => row.value,
    upsert: vi.fn(async () => ({})),
    updateMany: vi.fn(async () => ({ count: 1 })),
  },
} as unknown as Parameters<typeof resolveDeepseekConfig>[0];

import { resolveDeepseekConfig, saveAiModelSettings, loadAiModelSettings } from "./settings";

describe("настройки модели ассистента", () => {
  beforeEach(() => { envCfg.value = null; row.value = null; vi.clearAllMocks(); });

  it("без ключа нигде — конфигурации нет, ассистент молчит", async () => {
    expect(await resolveDeepseekConfig(prisma)).toBeNull();
  });

  it("ключ из окружения работает, пока в базе ничего не задано", async () => {
    envCfg.value = { apiKey: "env-key", baseUrl: "https://api.deepseek.com", model: "deepseek-chat" };
    expect(await resolveDeepseekConfig(prisma)).toEqual({ apiKey: "env-key", baseUrl: "https://api.deepseek.com", model: "deepseek-chat" });
  });

  it("настройка из базы СИЛЬНЕЕ окружения", async () => {
    envCfg.value = { apiKey: "env-key", baseUrl: "https://api.deepseek.com", model: "deepseek-chat" };
    row.value = { apiKeyEncrypted: "enc(ui-key)", baseUrl: "https://api.openai.com/v1", model: "gpt-4.1-mini" };
    expect(await resolveDeepseekConfig(prisma)).toEqual({ apiKey: "ui-key", baseUrl: "https://api.openai.com/v1", model: "gpt-4.1-mini" });
  });

  it("нерасшифровываемый ключ (сменили CREDENTIALS_ENCRYPTION_KEY) откатывается на окружение, а не роняет обработку", async () => {
    envCfg.value = { apiKey: "env-key", baseUrl: "https://api.deepseek.com", model: "deepseek-chat" };
    row.value = { apiKeyEncrypted: "битое", baseUrl: null, model: "gpt-4.1-mini" };
    expect(await resolveDeepseekConfig(prisma)).toMatchObject({ apiKey: "env-key", model: "gpt-4.1-mini" });
  });

  it("хвостовой слэш в адресе не ломает путь запроса", async () => {
    row.value = { apiKeyEncrypted: "enc(k)", baseUrl: "https://api.openai.com/v1/", model: "gpt-4.1-mini" };
    expect((await resolveDeepseekConfig(prisma))!.baseUrl).toBe("https://api.openai.com/v1");
  });

  it("пустое поле ключа означает «не менять»: в базу пишутся только адрес и модель", async () => {
    const r = await saveAiModelSettings(prisma, { apiKey: "", baseUrl: "https://api.openai.com/v1", model: "gpt-4.1-mini", userId: "u1" });
    expect(r).toEqual({ ok: true });
    const arg = (prisma.aiAssistantSettings.upsert as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(arg.update).not.toHaveProperty("apiKeyEncrypted");
    expect(arg.update).toMatchObject({ model: "gpt-4.1-mini", checkStatus: "saved_not_checked" });
  });

  it("новый ключ шифруется и получает маску из последних символов", async () => {
    await saveAiModelSettings(prisma, { apiKey: "  sk-proj-ABCD1234  ", baseUrl: "", model: "gpt-4.1-mini", userId: "u1" });
    const arg = (prisma.aiAssistantSettings.upsert as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(arg.update.apiKeyEncrypted).toBe("enc(sk-proj-ABCD1234)");
    expect(arg.update.apiKeyMask).toBe("********1234");
    expect(arg.update.baseUrl).toBeNull(); // пустой адрес — значит «из окружения»
  });

  it("модель обязательна, адрес обязан быть https", async () => {
    expect(await saveAiModelSettings(prisma, { apiKey: "", baseUrl: "", model: "  ", userId: "u1" })).toMatchObject({ ok: false });
    expect(await saveAiModelSettings(prisma, { apiKey: "", baseUrl: "http://api.example.com", model: "m", userId: "u1" })).toMatchObject({ ok: false });
    expect(prisma.aiAssistantSettings.upsert).not.toHaveBeenCalled();
  });

  it("на экран уходит только маска, расшифрованного ключа в ответе нет", async () => {
    row.value = { apiKeyEncrypted: "enc(секрет)", apiKeyMask: "********крет", baseUrl: null, model: "gpt-4.1-mini", checkStatus: "ok", checkAt: new Date("2026-09-09T10:00:00Z"), checkErrorSafe: null };
    const view = await loadAiModelSettings(prisma);
    expect(JSON.stringify(view)).not.toContain("секрет");
    expect(view.apiKeyMask).toBe("********крет");
    expect(view.usingEnvKey).toBe(false);
  });
});
