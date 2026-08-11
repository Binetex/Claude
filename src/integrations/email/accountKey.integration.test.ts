/**
 * Brevo API key ПО МАГАЗИНАМ на реальной БД (throwaway prisma dev).
 *
 * Главное: ключи магазинов независимы и не протекают друг в друга, общего/запасного ключа нет
 * (в том числе env BREVO_API_KEY больше ни на что не влияет), полное значение никогда не
 * возвращается наружу (только маска), а «Проверить подключение» переживает refresh.
 */
import { describe, it, expect, afterAll, beforeEach, vi } from "vitest";
import { prisma } from "@/lib/db";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

const { resolveBrevoApiKey, isBrevoConfiguredForSite, getBrevoAccountView, saveBrevoApiKey, clearBrevoApiKey, verifyAndRecordBrevoConnection } =
  await import("./accountKey");

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// Явно длиннее минимума (20 символов) — считать вручную не надёжно, поэтому одна общая константа.
const TEST_KEY = "test-brevo-api-key-1234567890";

const suffix = `brevokey-${Date.now()}`;
const siteIds: string[] = [];

async function makeSite(n: number): Promise<string> {
  const site = await prisma.site.create({
    data: { name: `Brevo Site ${suffix}-${n}`, shortName: `BK${n}`, platform: "WOOCOMMERCE" },
  });
  siteIds.push(site.id);
  return site.id;
}

let siteA = "";
let siteB = "";

beforeEach(async () => {
  fetchMock.mockReset();
  delete process.env.BREVO_API_KEY;
  siteA = await makeSite(siteIds.length);
  siteB = await makeSite(siteIds.length);
});

afterAll(async () => {
  await prisma.integrationSecret.deleteMany({ where: { siteId: { in: siteIds } } });
  await prisma.brevoAccountStatus.deleteMany({ where: { siteId: { in: siteIds } } });
  await prisma.site.deleteMany({ where: { id: { in: siteIds } } });
  await prisma.$disconnect();
});

describe("ключ принадлежит магазину", () => {
  it("ключа нет — resolve возвращает null", async () => {
    expect(await resolveBrevoApiKey(prisma, siteA)).toBeNull();
    expect(await isBrevoConfiguredForSite(prisma, siteA)).toBe(false);
  });

  it("env BREVO_API_KEY больше не подставляется", async () => {
    // Раньше env был общим запасным вариантом. Теперь молча отправить письмо из чужого аккаунта
    // хуже, чем не отправить: без ключа магазина отправки нет.
    process.env.BREVO_API_KEY = "env-only-key";
    expect(await resolveBrevoApiKey(prisma, siteA)).toBeNull();
    expect(await isBrevoConfiguredForSite(prisma, siteA)).toBe(false);
  });

  it("у каждого магазина свой ключ, чужой не подставляется", async () => {
    expect((await saveBrevoApiKey(prisma, siteA, "key-of-site-a-1234567890")).ok).toBe(true);
    expect(await resolveBrevoApiKey(prisma, siteA)).toBe("key-of-site-a-1234567890");
    expect(await resolveBrevoApiKey(prisma, siteB)).toBeNull();

    expect((await saveBrevoApiKey(prisma, siteB, "key-of-site-b-1234567890")).ok).toBe(true);
    expect(await resolveBrevoApiKey(prisma, siteA)).toBe("key-of-site-a-1234567890");
    expect(await resolveBrevoApiKey(prisma, siteB)).toBe("key-of-site-b-1234567890");
  });

  it("одинаковое значение у двух магазинов допустимо", async () => {
    expect((await saveBrevoApiKey(prisma, siteA, TEST_KEY)).ok).toBe(true);
    expect((await saveBrevoApiKey(prisma, siteB, TEST_KEY)).ok).toBe(true);
    expect(await resolveBrevoApiKey(prisma, siteA)).toBe(TEST_KEY);
    expect(await resolveBrevoApiKey(prisma, siteB)).toBe(TEST_KEY);
  });

  it("удаление ключа одного магазина не трогает другой", async () => {
    expect((await saveBrevoApiKey(prisma, siteA, "key-of-site-a-1234567890")).ok).toBe(true);
    expect((await saveBrevoApiKey(prisma, siteB, "key-of-site-b-1234567890")).ok).toBe(true);
    await clearBrevoApiKey(prisma, siteA);
    expect(await resolveBrevoApiKey(prisma, siteA)).toBeNull();
    expect(await resolveBrevoApiKey(prisma, siteB)).toBe("key-of-site-b-1234567890");
  });
});

describe("сохранение и маска", () => {
  it("маска не содержит полного значения", async () => {
    const res = await saveBrevoApiKey(prisma, siteA, "xkeysib-supersecretvalue1234567890");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.maskedSuffix).not.toContain("supersecretvalue");
      expect(res.maskedSuffix.length).toBeLessThan(20);
    }
    const view = await getBrevoAccountView(prisma, siteA);
    expect(view.configured).toBe(true);
    expect(view.maskedSuffix).not.toContain("supersecretvalue");
  });

  it("повторное сохранение заменяет предыдущий ключ, а не добавляет второй", async () => {
    expect((await saveBrevoApiKey(prisma, siteA, "first-key-1234567890")).ok).toBe(true);
    expect((await saveBrevoApiKey(prisma, siteA, "second-key-1234567890")).ok).toBe(true);
    const rows = await prisma.integrationSecret.findMany({ where: { provider: "BREVO", kind: "api_key", siteId: siteA } });
    expect(rows).toHaveLength(1);
    expect(await resolveBrevoApiKey(prisma, siteA)).toBe("second-key-1234567890");
  });

  it("пустое или слишком короткое значение отклоняется", async () => {
    expect((await saveBrevoApiKey(prisma, siteA, "")).ok).toBe(false);
    expect((await saveBrevoApiKey(prisma, siteA, "short")).ok).toBe(false);
    expect(await resolveBrevoApiKey(prisma, siteA)).toBeNull();
  });

  it("сохранение нового ключа сбрасывает статус предыдущей проверки", async () => {
    expect((await saveBrevoApiKey(prisma, siteA, "first-key-1234567890")).ok).toBe(true);
    fetchMock.mockResolvedValue(json(200, { email: "acc@example.com" }));
    await verifyAndRecordBrevoConnection(prisma, siteA);
    expect((await getBrevoAccountView(prisma, siteA)).connStatus).toBe("CONNECTED");

    expect((await saveBrevoApiKey(prisma, siteA, "second-key-1234567890")).ok).toBe(true);
    expect((await getBrevoAccountView(prisma, siteA)).connStatus).toBeNull();
  });
});

describe("удаление ключа", () => {
  it("после удаления магазин остаётся без ключа — запасного нет", async () => {
    expect((await saveBrevoApiKey(prisma, siteA, TEST_KEY)).ok).toBe(true);
    process.env.BREVO_API_KEY = "env-fallback-key";
    await clearBrevoApiKey(prisma, siteA);
    expect(await resolveBrevoApiKey(prisma, siteA)).toBeNull();
    const view = await getBrevoAccountView(prisma, siteA);
    expect(view.configured).toBe(false);
    expect(view.maskedSuffix).toBeNull();
  });

  it("удаление также стирает статус последней проверки", async () => {
    expect((await saveBrevoApiKey(prisma, siteA, TEST_KEY)).ok).toBe(true);
    fetchMock.mockResolvedValue(json(200, { email: "acc@example.com" }));
    await verifyAndRecordBrevoConnection(prisma, siteA);
    await clearBrevoApiKey(prisma, siteA);
    expect((await getBrevoAccountView(prisma, siteA)).connStatus).toBeNull();
  });
});

describe("проверка подключения переживает refresh", () => {
  it("успех сохраняет CONNECTED + accountEmail в БД", async () => {
    expect((await saveBrevoApiKey(prisma, siteA, TEST_KEY)).ok).toBe(true);
    fetchMock.mockResolvedValue(json(200, { email: "agency@example.com" }));
    const res = await verifyAndRecordBrevoConnection(prisma, siteA);
    expect(res).toEqual({ ok: true, accountEmail: "agency@example.com" });

    const view = await getBrevoAccountView(prisma, siteA);
    expect(view.connStatus).toBe("CONNECTED");
    expect(view.accountEmail).toBe("agency@example.com");
    expect(view.verifiedAt).not.toBeNull();
  });

  it("статус одного магазина не виден другому", async () => {
    expect((await saveBrevoApiKey(prisma, siteA, TEST_KEY)).ok).toBe(true);
    fetchMock.mockResolvedValue(json(200, { email: "a@example.com" }));
    await verifyAndRecordBrevoConnection(prisma, siteA);
    expect((await getBrevoAccountView(prisma, siteA)).connStatus).toBe("CONNECTED");
    expect((await getBrevoAccountView(prisma, siteB)).connStatus).toBeNull();
  });

  it("ошибка сохраняет безопасный текст, не значение ключа", async () => {
    expect((await saveBrevoApiKey(prisma, siteA, "bad-key-123456789012")).ok).toBe(true);
    fetchMock.mockResolvedValue(json(401, { message: "unauthorized" }));
    const res = await verifyAndRecordBrevoConnection(prisma, siteA);
    expect(res.ok).toBe(false); // подтверждаем, что реально дошли до сети и получили 401

    const view = await getBrevoAccountView(prisma, siteA);
    expect(view.connStatus).toBe("ERROR");
    expect(view.errorSafe).not.toContain("bad-key-123456789012");
  });

  it("без ключа вообще — понятная ошибка, в сеть не ходим", async () => {
    const res = await verifyAndRecordBrevoConnection(prisma, siteA);
    expect(res.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("повторная проверка обновляет ту же строку статуса, а не плодит новые", async () => {
    expect((await saveBrevoApiKey(prisma, siteA, TEST_KEY)).ok).toBe(true);
    fetchMock.mockResolvedValue(json(200, { email: "a@example.com" }));
    await verifyAndRecordBrevoConnection(prisma, siteA);
    await verifyAndRecordBrevoConnection(prisma, siteA);
    const rows = await prisma.brevoAccountStatus.findMany({ where: { siteId: siteA } });
    expect(rows).toHaveLength(1);
  });
});
