import { describe, it, expect, afterEach, vi } from "vitest";
import { prisma } from "@/lib/db";
import { saveBurqSettings, loadBurqSettingsForUi, checkBurqConnection, setBurqDraftCreation, getBurqDimensions, getBurqWebhookSecret, getBurqRuntimeClient } from "./settings";
import { intakeBurqWebhook } from "./webhookIntake";

/**
 * Интеграционные тесты настроек Burq (реальная БД + CREDENTIALS_ENCRYPTION_KEY). Проверяют, что
 * секреты хранятся ТОЛЬКО зашифрованными, наружу идут лишь маски, аудит не содержит секретов.
 */
const API_KEY = "sk_sandbox_supersecret_ABCD";
const WEBHOOK_SECRET = "whsec_signing_WXYZ";

afterEach(async () => {
  await prisma.burqSettingsAudit.deleteMany({});
  await prisma.burqSettings.deleteMany({});
  vi.unstubAllGlobals();
  delete process.env.BURQ_RUNTIME_ENABLED;
});

describe("saveBurqSettings — шифрование и маски", () => {
  it("шифрует ключ/секрет; в строке нет открытого текста; маска = ****ABCD", async () => {
    const res = await saveBurqSettings({ environment: "SANDBOX", apiKey: API_KEY, webhookSecret: WEBHOOK_SECRET, enabled: true }, "user-1");
    expect(res.ok).toBe(true);

    const row = await prisma.burqSettings.findUnique({ where: { id: "singleton" } });
    expect(row!.apiKeyEncrypted).toBeTruthy();
    expect(row!.apiKeyEncrypted).not.toContain(API_KEY); // не открытым текстом
    expect(row!.webhookSecretEncrypted).not.toContain(WEBHOOK_SECRET);
    expect(row!.apiKeyMask!.endsWith("ABCD")).toBe(true);
    expect(row!.apiKeyMask).not.toContain("supersecret");
  });

  it("UI-представление отдаёт только маски, без encrypted/plaintext", async () => {
    await saveBurqSettings({ environment: "SANDBOX", apiKey: API_KEY, webhookSecret: WEBHOOK_SECRET, enabled: true }, "user-1");
    const view = await loadBurqSettingsForUi();
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain(API_KEY);
    expect(serialized).not.toContain(WEBHOOK_SECRET);
    expect(serialized).not.toContain("Encrypted");
    expect(view.hasApiKey).toBe(true);
    expect(view.apiKeyMask!.endsWith("ABCD")).toBe(true);
  });

  it("пустой секрет = не менять (ключ сохраняется)", async () => {
    await saveBurqSettings({ environment: "SANDBOX", apiKey: API_KEY, enabled: true }, "user-1");
    const before = (await prisma.burqSettings.findUnique({ where: { id: "singleton" } }))!.apiKeyEncrypted;
    await saveBurqSettings({ environment: "SANDBOX", enabled: false }, "user-1"); // без apiKey
    const after = (await prisma.burqSettings.findUnique({ where: { id: "singleton" } }))!.apiKeyEncrypted;
    expect(after).toBe(before);
    expect((await prisma.burqSettings.findUnique({ where: { id: "singleton" } }))!.enabled).toBe(false);
  });

  it("аудит записывается без секретов", async () => {
    await saveBurqSettings({ environment: "SANDBOX", apiKey: API_KEY, webhookSecret: WEBHOOK_SECRET, enabled: true }, "user-42");
    const audits = await prisma.burqSettingsAudit.findMany({});
    expect(audits.length).toBeGreaterThanOrEqual(1);
    const a = audits[0];
    expect(a.userId).toBe("user-42");
    expect(a.action).toBe("save_credentials");
    expect(JSON.stringify(a)).not.toContain(API_KEY);
    expect(JSON.stringify(a)).not.toContain(WEBHOOK_SECRET);
  });
});

describe("checkBurqConnection — read-only, статус сохраняется", () => {
  it("200 → connectionStatus ok; аудит connection_check", async () => {
    await saveBurqSettings({ environment: "SANDBOX", apiKey: API_KEY, enabled: true }, "user-1");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200 }));
    const r = await checkBurqConnection("user-1");
    expect(r.ok).toBe(true);
    const row = await prisma.burqSettings.findUnique({ where: { id: "singleton" } });
    expect(row!.connectionStatus).toBe("ok");
    expect(row!.lastConnectionCheckAt).toBeTruthy();
    const audit = await prisma.burqSettingsAudit.findFirst({ where: { action: "connection_check" } });
    expect(audit).toBeTruthy();
  });

  it("401 → unauthorized; сообщение/ошибка без секрета", async () => {
    await saveBurqSettings({ environment: "SANDBOX", apiKey: API_KEY, enabled: true }, "user-1");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401 }));
    const r = await checkBurqConnection("user-1");
    expect(r.ok).toBe(false);
    expect(r.status).toBe("unauthorized");
    const row = await prisma.burqSettings.findUnique({ where: { id: "singleton" } });
    expect(row!.connectionStatus).toBe("unauthorized");
    expect(JSON.stringify(row)).not.toContain(API_KEY);
  });

  it("без ключа → no_key, без сетевого вызова", async () => {
    const r = await checkBurqConnection("user-1");
    expect(r.status).toBe("no_key");
  });
});

describe("dimensions — настраиваемые глобально, дефолт при отсутствии", () => {
  it("до сохранения → дефолт (12/8/8/3 in/lb)", async () => {
    expect(await getBurqDimensions()).toEqual({ length: 12, width: 8, height: 8, weight: 3, dimensionUnit: "in", weightUnit: "lb" });
  });
  it("сохранённые размеры возвращаются в view и getBurqDimensions", async () => {
    await saveBurqSettings(
      { environment: "SANDBOX", enabled: false, dimensions: { length: 24, width: 12, height: 12, weight: 6, dimensionUnit: "cm", weightUnit: "kg" } },
      "user-1"
    );
    expect(await getBurqDimensions()).toEqual({ length: 24, width: 12, height: 12, weight: 6, dimensionUnit: "cm", weightUnit: "kg" });
    expect((await loadBurqSettingsForUi()).dimensions.length).toBe(24);
  });
});

describe("runtime credential wiring — секрет/клиент из БД, а не env", () => {
  it("getBurqWebhookSecret возвращает расшифрованный секрет из БД", async () => {
    await saveBurqSettings({ environment: "SANDBOX", webhookSecret: WEBHOOK_SECRET, enabled: true }, "user-1");
    expect(await getBurqWebhookSecret()).toBe(WEBHOOK_SECRET);
  });

  it("getBurqRuntimeClient: runtime OFF → mock даже при сохранённом ключе", async () => {
    await saveBurqSettings({ environment: "PRODUCTION", apiKey: API_KEY, enabled: true }, "user-1");
    delete process.env.BURQ_RUNTIME_ENABLED;
    expect((await getBurqRuntimeClient()).mode).toBe("mock");
  });

  it("getBurqRuntimeClient: runtime ON + ключ в БД → real (без сетевого вызова)", async () => {
    await saveBurqSettings({ environment: "PRODUCTION", apiKey: API_KEY, enabled: true }, "user-1");
    process.env.BURQ_RUNTIME_ENABLED = "true";
    expect((await getBurqRuntimeClient()).mode).toBe("real");
  });

  it("getBurqRuntimeClient: runtime ON, но ключа нет → mock", async () => {
    process.env.BURQ_RUNTIME_ENABLED = "true";
    expect((await getBurqRuntimeClient()).mode).toBe("mock");
  });

  it("intakeBurqWebhook: runtime ON + секрет в БД + плохая подпись → 401 (НЕ 503)", async () => {
    await saveBurqSettings({ environment: "PRODUCTION", webhookSecret: WEBHOOK_SECRET, enabled: true }, "user-1");
    process.env.BURQ_RUNTIME_ENABLED = "true";
    const res = await intakeBurqWebhook({ rawBody: '{"data":{"id":"x","status":"delivered"}}', headers: { "burq-signature": "t=1,v1=deadbeef" } });
    expect(res.status).toBe(401); // подпись проверяется → секрет загружен из БД (иначе было бы 503)
  });

  it("intakeBurqWebhook: runtime ON, но секрета нет → 503 webhook not configured", async () => {
    process.env.BURQ_RUNTIME_ENABLED = "true";
    const res = await intakeBurqWebhook({ rawBody: "{}", headers: {} });
    expect(res.status).toBe(503);
  });
});

describe("setBurqDraftCreation — отдельный гейт", () => {
  it("по умолчанию выкл; включается отдельно; аудит", async () => {
    await saveBurqSettings({ environment: "SANDBOX", apiKey: API_KEY, enabled: true }, "user-1");
    expect((await loadBurqSettingsForUi()).draftCreationEnabled).toBe(false);
    const r = await setBurqDraftCreation(true, "user-1");
    expect(r.ok).toBe(true);
    expect((await loadBurqSettingsForUi()).draftCreationEnabled).toBe(true);
    const audit = await prisma.burqSettingsAudit.findFirst({ where: { action: "toggle_draft_creation" } });
    expect(audit!.detailSafe).toBe("draftCreationEnabled=true");
  });
});
