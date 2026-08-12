/**
 * Приём входящих писем на реальной БД (throwaway prisma dev). Провайдер замокан через fetch.
 *
 * Проверяется то, из-за чего переписка попала бы не тому человеку или потерялась: письмо
 * привязывается к САМОМУ СВЕЖЕМУ заказу клиента, чужое письмо не попадает ни в чей заказ, повтор
 * опроса не плодит дублей, а курсор двигается вперёд и не застревает на непривязанных письмах.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { randomBytes } from "node:crypto";

process.env.CREDENTIALS_ENCRYPTION_KEY ||= randomBytes(32).toString("base64");

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

import { prisma } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { saveEmailFactoryToken } from "./token";
import { ingestInboundEmails } from "./ingest";

const suffix = `efing-${Date.now()}`;
const siteIds: string[] = [];
const orderIds: string[] = [];

const reply = (messages: unknown[]) =>
  new Response(JSON.stringify({ data: messages }), { status: 200, headers: { "content-type": "application/json" } });

/** Письмо в том виде, в каком его отдаёт провайдер (поля сняты с живого API). */
const msg = (id: string, from: string, at: Date, extra: Record<string, unknown> = {}) => ({
  id,
  threadId: `thr-${id}`,
  direction: "INBOUND",
  status: "RECEIVED",
  from,
  to: "client@theflow.la",
  subject: "Where is my bouquet?",
  text: "Здравствуйте!",
  receivedAt: at.toISOString(),
  ...extra,
});

async function makeOrder(email: string, placedAt: Date): Promise<string> {
  const site =
    (await prisma.site.findFirst({ where: { name: `EF Site ${suffix}` } })) ??
    (await prisma.site.create({ data: { name: `EF Site ${suffix}`, shortName: `EF${suffix.slice(-4)}`, platform: "WOOCOMMERCE" } }));
  if (!siteIds.includes(site.id)) siteIds.push(site.id);

  const order = await prisma.order.create({
    data: {
      orderNumber: `EF-${suffix}-${orderIds.length}`,
      site: { connect: { id: site.id } },
      platform: "WOOCOMMERCE",
      source: "Website",
      externalCreatedAt: placedAt,
      deliveryDate: new Date(),
      deliveryWindow: "12:00 – 16:00",
      senderName: "Anna",
      senderPhone: "+15551112222",
      senderEmail: email,
      recipientName: "Bob",
      recipientPhone: "+15553334444",
      addressLine: "1 Main St",
      city: "Portland",
      zip: "00000",
      itemsTotal: new Prisma.Decimal(100),
      customerTotal: new Prisma.Decimal(115),
      paymentStatus: "PAID",
      orderStatus: "CONFIRMED",
    },
  });
  orderIds.push(order.id);
  return order.id;
}

beforeEach(async () => {
  fetchMock.mockReset();
  await prisma.orderEmailMessage.deleteMany({});
  await saveEmailFactoryToken(prisma, "ef-token-for-tests-1234567890");
});

afterAll(async () => {
  await prisma.orderEmailMessage.deleteMany({});
  await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  await prisma.site.deleteMany({ where: { id: { in: siteIds } } });
  await prisma.integrationSecret.deleteMany({ where: { provider: "EMAIL_FACTORY" } });
  await prisma.$disconnect();
});

describe("привязка к заказу", () => {
  it("письмо уходит в САМЫЙ СВЕЖИЙ заказ этого клиента", async () => {
    const email = `sarah-${suffix}@example.com`;
    const old = await makeOrder(email, new Date("2026-01-01"));
    const fresh = await makeOrder(email, new Date("2026-08-01"));

    fetchMock.mockResolvedValueOnce(reply([msg("m1", email, new Date())]));
    const res = await ingestInboundEmails(prisma);

    expect(res).toMatchObject({ fetched: 1, stored: 1, matched: 1, skipped: null });
    const row = await prisma.orderEmailMessage.findUniqueOrThrow({ where: { providerMessageId: "m1" } });
    expect(row.orderId).toBe(fresh);
    expect(row.orderId).not.toBe(old);
  });

  it("адрес сравнивается без учёта регистра", async () => {
    const email = `bob-${suffix}@example.com`;
    const orderId = await makeOrder(email, new Date("2026-08-01"));

    fetchMock.mockResolvedValueOnce(reply([msg("m2", email.toUpperCase(), new Date())]));
    await ingestInboundEmails(prisma);

    expect((await prisma.orderEmailMessage.findUniqueOrThrow({ where: { providerMessageId: "m2" } })).orderId).toBe(orderId);
  });

  it("письмо от незнакомого адреса сохраняется, но НИ К КАКОМУ заказу не привязывается", async () => {
    await makeOrder(`known-${suffix}@example.com`, new Date("2026-08-01"));

    fetchMock.mockResolvedValueOnce(reply([msg("m3", `stranger-${suffix}@example.com`, new Date())]));
    const res = await ingestInboundEmails(prisma);

    // Сохраняем: без этого курсор застрял бы на последнем ПРИВЯЗАННОМ письме и одни и те же
    // письма выгружались бы снова и снова. Показывается такое письмо всё равно нигде.
    expect(res).toMatchObject({ stored: 1, matched: 0 });
    expect((await prisma.orderEmailMessage.findUniqueOrThrow({ where: { providerMessageId: "m3" } })).orderId).toBeNull();
  });
});

describe("повторы и курсор", () => {
  it("тот же providerMessageId не создаёт вторую строку", async () => {
    const email = `dup-${suffix}@example.com`;
    await makeOrder(email, new Date("2026-08-01"));
    const at = new Date();

    fetchMock.mockResolvedValueOnce(reply([msg("m4", email, at)]));
    await ingestInboundEmails(prisma);
    // Нахлёст по времени специально заставляет провайдера отдать то же письмо второй раз.
    fetchMock.mockResolvedValueOnce(reply([msg("m4", email, at)]));
    const second = await ingestInboundEmails(prisma);

    expect(second.stored).toBe(0);
    expect(await prisma.orderEmailMessage.count({ where: { providerMessageId: "m4" } })).toBe(1);
  });

  it("курсор идёт от последнего письма с нахлёстом, а не от начала времён", async () => {
    const email = `cur-${suffix}@example.com`;
    await makeOrder(email, new Date("2026-08-01"));
    const at = new Date("2026-08-10T12:00:00Z");

    fetchMock.mockResolvedValueOnce(reply([msg("m5", email, at)]));
    await ingestInboundEmails(prisma);

    fetchMock.mockResolvedValueOnce(reply([]));
    await ingestInboundEmails(prisma);

    const url = String(fetchMock.mock.calls[1][0]);
    const since = new Date(new URL(url).searchParams.get("since")!);
    expect(since.getTime()).toBe(at.getTime() - 2 * 60_000);
    expect(url).toContain("direction=INBOUND");
  });
});

describe("когда работать нечем", () => {
  it("без токена опрос молчит и к провайдеру не ходит", async () => {
    await prisma.integrationSecret.deleteMany({ where: { provider: "EMAIL_FACTORY" } });

    expect(await ingestInboundEmails(prisma)).toMatchObject({ stored: 0, skipped: "no_token" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("ошибка провайдера возвращается кодом, а не исключением", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: "RATE_LIMITED" } }), { status: 429 }));

    expect(await ingestInboundEmails(prisma)).toMatchObject({ stored: 0, skipped: "ef_rate_limited" });
  });
});
