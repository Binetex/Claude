/**
 * Email-настройки магазинов на реальной БД (throwaway prisma dev).
 *
 * Главное, что проверяется: письмо магазина не может уйти с отправителем или шаблоном ДРУГОГО
 * магазина, а незавершённая настройка даёт понятную причину пропуска, а не исключение.
 * Brevo при этом замокан — реальных отправок здесь нет.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { prisma } from "@/lib/db";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

const { resolveSiteEmailConfig, resolveSiteTemplateId, saveSiteEmailSettings, saveSiteEmailTemplate } = await import("./settings");
const { sendSiteTestEmail } = await import("./testSend");
const { createBrevoProvider } = await import("./brevo");

const RUN = `em-${Date.now()}`;
const siteIds: string[] = [];
let flowId = "";
let julieId = "";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function makeSite(shortName: string, name: string) {
  const s = await prisma.site.create({ data: { name, shortName: `${shortName}${siteIds.length}`, platform: "WOOCOMMERCE" } });
  siteIds.push(s.id);
  return s.id;
}

beforeAll(async () => {
  flowId = await makeSite("FLW", `The Flow ${RUN}`);
  julieId = await makeSite("JF", `Julies Flowers ${RUN}`);
});

beforeEach(async () => {
  fetchMock.mockReset();
  delete process.env.BREVO_API_KEY; // env больше не участвует: ключ только свой у магазина
  await giveKey(flowId);
  await giveKey(julieId);
});

/** Ключ Brevo магазина. Значение здесь не расшифровывается — важен сам факт наличия строки. */
async function giveKey(siteId: string) {
  await prisma.integrationSecret.deleteMany({ where: { provider: "BREVO", kind: "api_key", siteId } });
  await prisma.integrationSecret.create({
    data: { provider: "BREVO", kind: "api_key", encryptedValue: "enc", maskedSuffix: "****key", active: true, siteId },
  });
}

async function takeKeyAway(siteId: string) {
  await prisma.integrationSecret.deleteMany({ where: { provider: "BREVO", kind: "api_key", siteId } });
}

afterAll(async () => {
  await prisma.integrationSecret.deleteMany({ where: { siteId: { in: siteIds } } });
  await prisma.siteEmailTemplate.deleteMany({ where: { siteId: { in: siteIds } } });
  await prisma.siteEmailSettings.deleteMany({ where: { siteId: { in: siteIds } } });
  await prisma.site.deleteMany({ where: { id: { in: siteIds } } });
  await prisma.$disconnect();
});

/** Полностью настроенный магазин — общий шаг для проверок отправки. */
async function configure(siteId: string, senderEmail: string, senderName: string) {
  await saveSiteEmailSettings(prisma, siteId, { senderEmail, senderName, domainVerified: true });
  await saveSiteEmailSettings(prisma, siteId, { enabled: true });
}

describe("значения по умолчанию", () => {
  it("новый магазин: Email выключен и настроек нет — рассылки невозможны", async () => {
    const fresh = await makeSite("NEW", `Fresh ${RUN}`);
    expect(await prisma.siteEmailSettings.findUnique({ where: { siteId: fresh } })).toBeNull();

    const res = await resolveSiteEmailConfig(prisma, fresh);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.skip).toBe("site_email_disabled");
  });
});

describe("гейты конфигурации", () => {
  it("без своего ключа Brevo отправка магазину невозможна", async () => {
    await takeKeyAway(flowId);
    await configure(flowId, "orders@theflow.la", "The Flow");
    const res = await resolveSiteEmailConfig(prisma, flowId);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.skip).toBe("email_not_configured");
  });

  it("включить Email без адреса отправителя нельзя", async () => {
    const s = await makeSite("NOSND", `No sender ${RUN}`);
    const res = await saveSiteEmailSettings(prisma, s, { enabled: true });
    expect("error" in res && res.error).toContain("адрес отправителя");
  });

  it("включить Email без подтверждённого домена нельзя", async () => {
    const s = await makeSite("NOVER", `No verify ${RUN}`);
    await saveSiteEmailSettings(prisma, s, { senderEmail: "orders@example.com" });
    const res = await saveSiteEmailSettings(prisma, s, { enabled: true });
    expect("error" in res && res.error).toContain("подтверждённый");
  });

  it("настроенный, но выключенный магазин даёт причину site_email_disabled", async () => {
    const s = await makeSite("OFF", `Off ${RUN}`);
    await configure(s, "orders@off.example", "Off");
    await saveSiteEmailSettings(prisma, s, { enabled: false });
    const res = await resolveSiteEmailConfig(prisma, s);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.skip).toBe("site_email_disabled");
  });

  it("некорректный адрес отправителя и Reply-To отклоняются", async () => {
    const s = await makeSite("BAD", `Bad ${RUN}`);
    expect("error" in (await saveSiteEmailSettings(prisma, s, { senderEmail: "не-адрес" }))).toBe(true);
    expect("error" in (await saveSiteEmailSettings(prisma, s, { replyTo: "тоже-не-адрес" }))).toBe(true);
  });
});

describe("изоляция магазинов", () => {
  it("каждый магазин отправляет со своего адреса", async () => {
    await configure(flowId, "orders@theflow.la", "The Flow");
    await configure(julieId, "orders@juliesflowers.net", "Julies Flowers");

    const a = await resolveSiteEmailConfig(prisma, flowId);
    const b = await resolveSiteEmailConfig(prisma, julieId);
    expect(a.ok && a.config.senderEmail).toBe("orders@theflow.la");
    expect(b.ok && b.config.senderEmail).toBe("orders@juliesflowers.net");
    expect(a.ok && a.config.siteName).toContain("The Flow");
  });

  it("шаблон одного магазина не виден другому", async () => {
    await saveSiteEmailTemplate(prisma, flowId, "ORDER_CREATED", 101);

    const own = await resolveSiteTemplateId(prisma, flowId, "ORDER_CREATED");
    expect(own.ok && own.templateId).toBe(101);

    // У второго магазина шаблона для этого события нет — «одолжить» чужой нельзя.
    const other = await resolveSiteTemplateId(prisma, julieId, "ORDER_CREATED");
    expect(other.ok).toBe(false);
    if (!other.ok) expect(other.skip).toBe("site_template_missing");
  });

  it("тестовое письмо уходит с отправителем и шаблоном ИМЕННО своего магазина", async () => {
    await configure(julieId, "orders@juliesflowers.net", "Julies Flowers");
    await saveSiteEmailTemplate(prisma, julieId, "ORDER_CREATED", 202);
    fetchMock.mockResolvedValue(json(201, { messageId: "m-julie" }));

    const res = await sendSiteTestEmail(prisma, createBrevoProvider("site-key"), { siteId: julieId, to: "test@example.com" });
    expect(res.ok).toBe(true);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.sender.email).toBe("orders@juliesflowers.net");
    expect(body.templateId).toBe(202); // не 101 от The Flow
    expect(body.params.store_name).toContain("Julies Flowers");
  });
});

describe("тестовое письмо", () => {
  it("успех записывает статус ok и messageId провайдера", async () => {
    await configure(flowId, "orders@theflow.la", "The Flow");
    await saveSiteEmailTemplate(prisma, flowId, "ORDER_CREATED", 101);
    fetchMock.mockResolvedValue(json(201, { messageId: "m-1" }));

    const res = await sendSiteTestEmail(prisma, createBrevoProvider("site-key"), { siteId: flowId, to: "test@example.com" });
    expect(res).toEqual({ ok: true, providerMessageId: "m-1" });

    const s = await prisma.siteEmailSettings.findUniqueOrThrow({ where: { siteId: flowId } });
    expect(s.lastTestStatus).toBe("ok");
    expect(s.lastErrorSafe).toBeNull();
    expect(s.lastTestAt).not.toBeNull();
  });

  it("ошибка провайдера записывается безопасно и не роняет вызов", async () => {
    await configure(flowId, "orders@theflow.la", "The Flow");
    await saveSiteEmailTemplate(prisma, flowId, "ORDER_CREATED", 101);
    fetchMock.mockResolvedValue(json(401, { message: "unauthorized key abc123" }));

    const res = await sendSiteTestEmail(prisma, createBrevoProvider("site-key"), { siteId: flowId, to: "test@example.com" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("brevo_unauthorized");

    const s = await prisma.siteEmailSettings.findUniqueOrThrow({ where: { siteId: flowId } });
    expect(s.lastTestStatus).toBe("error");
    expect(s.lastErrorSafe).not.toContain("abc123"); // ключ не протёк в БД
  });

  it("без шаблонов тест не отправляется, а объясняет причину", async () => {
    const s = await makeSite("NOTPL", `No tpl ${RUN}`);
    await configure(s, "orders@notpl.example", "No Tpl");
    await giveKey(s); // проверяем именно отсутствие ШАБЛОНА, поэтому ключ у магазина есть

    const res = await sendSiteTestEmail(prisma, createBrevoProvider("site-key"), { siteId: s, to: "test@example.com" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("site_template_missing");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("некорректный адрес получателя не доходит до Brevo", async () => {
    await configure(flowId, "orders@theflow.la", "The Flow");
    const res = await sendSiteTestEmail(prisma, createBrevoProvider("site-key"), { siteId: flowId, to: "мусор" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("invalid_recipient_email");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("демо-переменные передаются с теми же именами, что в автоматизациях", async () => {
    await configure(flowId, "orders@theflow.la", "The Flow");
    await saveSiteEmailTemplate(prisma, flowId, "ORDER_CREATED", 101);
    fetchMock.mockResolvedValue(json(201, { messageId: "m" }));

    await sendSiteTestEmail(prisma, createBrevoProvider("site-key"), { siteId: flowId, to: "test@example.com" });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    for (const key of ["order_number", "recipient_name", "delivery_date", "delivery_time", "tracking_url", "store_name"]) {
      expect(body.params[key]).toBeTruthy();
    }
  });
});

describe("шаблоны по событиям", () => {
  it("сохраняются по паре магазин+событие и обновляются, не дублируясь", async () => {
    await saveSiteEmailTemplate(prisma, flowId, "ORDER_DELIVERED", 301);
    await saveSiteEmailTemplate(prisma, flowId, "ORDER_DELIVERED", 302);
    const rows = await prisma.siteEmailTemplate.findMany({ where: { siteId: flowId, triggerType: "ORDER_DELIVERED" } });
    expect(rows).toHaveLength(1);
    expect(rows[0].brevoTemplateId).toBe(302);
  });

  it("пустое значение убирает шаблон", async () => {
    await saveSiteEmailTemplate(prisma, flowId, "PAYMENT_FAILED", 400);
    await saveSiteEmailTemplate(prisma, flowId, "PAYMENT_FAILED", null);
    const res = await resolveSiteTemplateId(prisma, flowId, "PAYMENT_FAILED");
    expect(res.ok).toBe(false);
  });

  it("нецелые и отрицательные id отклоняются", async () => {
    expect("error" in (await saveSiteEmailTemplate(prisma, flowId, "ORDER_CREATED", 0))).toBe(true);
    expect("error" in (await saveSiteEmailTemplate(prisma, flowId, "ORDER_CREATED", -5))).toBe(true);
    expect("error" in (await saveSiteEmailTemplate(prisma, flowId, "ORDER_CREATED", 1.5))).toBe(true);
  });
});
