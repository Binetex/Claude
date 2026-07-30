/**
 * Общий Brevo API key на реальной БД (throwaway prisma dev).
 *
 * Главное: ключ из БД приоритетнее env, полное значение никогда не возвращается наружу (только
 * маска), а «Проверить подключение» переживает refresh (статус пишется в БД).
 */
import { describe, it, expect, afterAll, beforeEach, vi } from "vitest";
import { prisma } from "@/lib/db";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

const { resolveBrevoApiKey, isBrevoConfiguredAnywhere, getBrevoAccountView, saveBrevoApiKey, clearBrevoApiKey, verifyAndRecordBrevoConnection } =
  await import("./accountKey");

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// Явно длиннее минимума (20 символов) — считать вручную не надёжно, поэтому одна общая константа.
const TEST_KEY = "test-brevo-api-key-1234567890";

beforeEach(async () => {
  fetchMock.mockReset();
  delete process.env.BREVO_API_KEY;
  await prisma.integrationSecret.deleteMany({ where: { provider: "BREVO", kind: "api_key" } });
  await prisma.brevoAccountStatus.deleteMany({});
});

afterAll(async () => {
  await prisma.integrationSecret.deleteMany({ where: { provider: "BREVO", kind: "api_key" } });
  await prisma.brevoAccountStatus.deleteMany({});
  await prisma.$disconnect();
});

describe("источник ключа: БД приоритетнее env", () => {
  it("ничего не задано — resolve возвращает null", async () => {
    expect(await resolveBrevoApiKey(prisma)).toBeNull();
    expect(await isBrevoConfiguredAnywhere(prisma)).toBe(false);
  });

  it("только env — используется он", async () => {
    process.env.BREVO_API_KEY = "env-only-key";
    expect(await resolveBrevoApiKey(prisma)).toBe("env-only-key");
  });

  it("только БД — используется он", async () => {
    expect((await saveBrevoApiKey(prisma, "db-only-key-1234567890")).ok).toBe(true);
    expect(await resolveBrevoApiKey(prisma)).toBe("db-only-key-1234567890");
  });

  it("заданы оба — БД побеждает", async () => {
    process.env.BREVO_API_KEY = "env-key";
    const saved = await saveBrevoApiKey(prisma, TEST_KEY);
    expect(saved.ok).toBe(true);
    expect(await resolveBrevoApiKey(prisma)).toBe(TEST_KEY);
  });
});

describe("сохранение и маска", () => {
  it("маска не содержит полного значения", async () => {
    const res = await saveBrevoApiKey(prisma, "xkeysib-supersecretvalue1234567890");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.maskedSuffix).not.toContain("supersecretvalue");
      expect(res.maskedSuffix.length).toBeLessThan(20);
    }
    const view = await getBrevoAccountView(prisma);
    expect(view.source).toBe("db");
    expect(view.maskedSuffix).not.toContain("supersecretvalue");
  });

  it("повторное сохранение заменяет предыдущий ключ, а не добавляет второй", async () => {
    expect((await saveBrevoApiKey(prisma, "first-key-1234567890")).ok).toBe(true);
    expect((await saveBrevoApiKey(prisma, "second-key-1234567890")).ok).toBe(true);
    const rows = await prisma.integrationSecret.findMany({ where: { provider: "BREVO", kind: "api_key" } });
    expect(rows).toHaveLength(1);
    expect(await resolveBrevoApiKey(prisma)).toBe("second-key-1234567890");
  });

  it("пустое или слишком короткое значение отклоняется", async () => {
    expect((await saveBrevoApiKey(prisma, "")).ok).toBe(false);
    expect((await saveBrevoApiKey(prisma, "short")).ok).toBe(false);
    expect(await resolveBrevoApiKey(prisma)).toBeNull();
  });

  it("сохранение нового ключа сбрасывает статус предыдущей проверки", async () => {
    expect((await saveBrevoApiKey(prisma, "first-key-1234567890")).ok).toBe(true);
    fetchMock.mockResolvedValue(json(200, { email: "acc@example.com" }));
    await verifyAndRecordBrevoConnection(prisma);
    expect((await getBrevoAccountView(prisma)).connStatus).toBe("CONNECTED");

    expect((await saveBrevoApiKey(prisma, "second-key-1234567890")).ok).toBe(true);
    expect((await getBrevoAccountView(prisma)).connStatus).toBeNull();
  });
});

describe("удаление ключа", () => {
  it("после удаления из БД остаётся только env (если задан)", async () => {
    expect((await saveBrevoApiKey(prisma, TEST_KEY)).ok).toBe(true);
    process.env.BREVO_API_KEY = "env-fallback-key";
    await clearBrevoApiKey(prisma);
    expect(await resolveBrevoApiKey(prisma)).toBe("env-fallback-key");
    const view = await getBrevoAccountView(prisma);
    expect(view.source).toBe("env");
    expect(view.maskedSuffix).toBeNull();
  });

  it("удаление также стирает статус последней проверки", async () => {
    expect((await saveBrevoApiKey(prisma, TEST_KEY)).ok).toBe(true);
    fetchMock.mockResolvedValue(json(200, { email: "acc@example.com" }));
    await verifyAndRecordBrevoConnection(prisma);
    await clearBrevoApiKey(prisma);
    expect((await getBrevoAccountView(prisma)).connStatus).toBeNull();
  });
});

describe("проверка подключения переживает refresh", () => {
  it("успех сохраняет CONNECTED + accountEmail в БД", async () => {
    expect((await saveBrevoApiKey(prisma, TEST_KEY)).ok).toBe(true);
    fetchMock.mockResolvedValue(json(200, { email: "agency@example.com" }));
    const res = await verifyAndRecordBrevoConnection(prisma);
    expect(res).toEqual({ ok: true, accountEmail: "agency@example.com" });

    const view = await getBrevoAccountView(prisma);
    expect(view.connStatus).toBe("CONNECTED");
    expect(view.accountEmail).toBe("agency@example.com");
    expect(view.verifiedAt).not.toBeNull();
  });

  it("ошибка сохраняет безопасный текст, не значение ключа", async () => {
    expect((await saveBrevoApiKey(prisma, "bad-key-123456789012")).ok).toBe(true);
    fetchMock.mockResolvedValue(json(401, { message: "unauthorized" }));
    const res = await verifyAndRecordBrevoConnection(prisma);
    expect(res.ok).toBe(false); // подтверждаем, что реально дошли до сети и получили 401

    const view = await getBrevoAccountView(prisma);
    expect(view.connStatus).toBe("ERROR");
    expect(view.errorSafe).not.toContain("bad-key-123456789012");
  });

  it("без ключа вообще — понятная ошибка, в сеть не ходим", async () => {
    const res = await verifyAndRecordBrevoConnection(prisma);
    expect(res.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("повторная проверка обновляет ту же строку статуса, а не плодит новые", async () => {
    expect((await saveBrevoApiKey(prisma, TEST_KEY)).ok).toBe(true);
    fetchMock.mockResolvedValue(json(200, { email: "a@example.com" }));
    await verifyAndRecordBrevoConnection(prisma);
    await verifyAndRecordBrevoConnection(prisma);
    const rows = await prisma.brevoAccountStatus.findMany({});
    expect(rows).toHaveLength(1);
  });
});
