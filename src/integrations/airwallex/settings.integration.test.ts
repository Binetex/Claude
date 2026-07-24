/**
 * Настройки Airwallex Monitoring на реальной БД (throwaway prisma dev). Проверяем правила
 * безопасности, которые нельзя увидеть глазами: пустой ключ не стирает, изменение сбрасывает
 * проверку, включение только после Verify, credentials не утекают в view.
 */
import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { prisma } from "@/lib/db";
import { loadAirwallexSettings, saveAirwallexSettings, setAirwallexMonitoring, resolveAirwallexCreds } from "./settings";

process.env.CREDENTIALS_ENCRYPTION_KEY ||= Buffer.alloc(32, 5).toString("base64");
const suffix = `awit-${Date.now()}`;
const siteIds: string[] = [];

async function makeWooSite() {
  const site = await prisma.site.create({ data: { name: `AW ${suffix}-${siteIds.length}`, shortName: `AW${siteIds.length}`, platform: "WOOCOMMERCE" } });
  siteIds.push(site.id);
  await prisma.wooCommerceConnection.create({
    data: {
      siteId: site.id, storeUrl: `https://aw-${suffix}-${siteIds.length}.example`, apiBaseUrl: "x", apiVersion: "wc/v3",
      consumerKeyEncrypted: "x", consumerSecretEncrypted: "x", consumerSecretMask: "****",
    },
  });
  return site.id;
}

beforeEach(() => {});
afterAll(async () => {
  await prisma.wooCommerceConnection.deleteMany({ where: { siteId: { in: siteIds } } });
  await prisma.site.deleteMany({ where: { id: { in: siteIds } } });
  await prisma.$disconnect();
});

describe("сохранение credentials", () => {
  it("сохраняет зашифрованно, наружу — только маска", async () => {
    const s = await makeWooSite();
    await saveAirwallexSettings(prisma, s, { clientId: "cid_123", apiKey: "very-secret-key-abcd", env: "prod", pendingThresholdMin: 45 });
    const view = await loadAirwallexSettings(prisma, s);
    expect(view).toMatchObject({ clientIdConfigured: true, apiKeyConfigured: true, env: "prod", pendingThresholdMin: 45 });
    expect(JSON.stringify(view)).not.toContain("very-secret-key-abcd");
    expect(JSON.stringify(view)).not.toContain("cid_123");
    expect(view!.apiKeyMask).toMatch(/abcd$/);
    // на сервере расшифровывается для вызовов
    expect(await resolveAirwallexCreds(prisma, s)).toEqual({ clientId: "cid_123", apiKey: "very-secret-key-abcd", env: "prod" });
  });

  it("пустой ключ НЕ стирает существующий", async () => {
    const s = await makeWooSite();
    await saveAirwallexSettings(prisma, s, { clientId: "cid", apiKey: "key-xyz", env: "prod" });
    await saveAirwallexSettings(prisma, s, { clientId: "", apiKey: "", env: "prod", pendingThresholdMin: 60 });
    const creds = await resolveAirwallexCreds(prisma, s);
    expect(creds).toMatchObject({ clientId: "cid", apiKey: "key-xyz" });
    expect((await loadAirwallexSettings(prisma, s))!.pendingThresholdMin).toBe(60);
  });

  it("смена окружения сбрасывает проверку и выключает мониторинг", async () => {
    const s = await makeWooSite();
    await saveAirwallexSettings(prisma, s, { clientId: "c", apiKey: "k", env: "prod" });
    // имитируем пройденную проверку
    await prisma.wooCommerceConnection.update({ where: { siteId: s }, data: { airwallexApiVerifiedAt: new Date(), airwallexMonitoringEnabled: true } });
    await saveAirwallexSettings(prisma, s, { env: "demo" });
    const v = await loadAirwallexSettings(prisma, s);
    expect(v!.verifiedAt).toBeNull();
    expect(v!.monitoringEnabled).toBe(false);
  });
});

describe("включение мониторинга", () => {
  it("без Verify включить нельзя", async () => {
    const s = await makeWooSite();
    await saveAirwallexSettings(prisma, s, { clientId: "c", apiKey: "k", env: "prod" });
    const r = await setAirwallexMonitoring(prisma, s, true);
    expect(r).toMatchObject({ error: expect.stringContaining("Verify") });
    expect((await loadAirwallexSettings(prisma, s))!.monitoringEnabled).toBe(false);
  });

  it("после Verify включается; выключить можно всегда", async () => {
    const s = await makeWooSite();
    await saveAirwallexSettings(prisma, s, { clientId: "c", apiKey: "k", env: "prod" });
    await prisma.wooCommerceConnection.update({ where: { siteId: s }, data: { airwallexApiVerifiedAt: new Date() } });
    expect(await setAirwallexMonitoring(prisma, s, true)).toEqual({ ok: true });
    expect(await setAirwallexMonitoring(prisma, s, false)).toEqual({ ok: true });
  });
});

describe("резолв", () => {
  it("не настроено → null (нельзя опрашивать)", async () => {
    const s = await makeWooSite();
    expect(await resolveAirwallexCreds(prisma, s)).toBeNull();
  });
});
