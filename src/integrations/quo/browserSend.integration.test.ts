/**
 * Отправка SMS браузером Quo на реальной БД (throwaway prisma dev): развилка браузер / воркер / API,
 * защита от второго SMS клиенту и сверка вебхука с записью без id сообщения. Сам браузер — подделка:
 * робот (`browser/robot.ts`) проверяется вживую, здесь — всё, что вокруг него.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { prisma } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { sendOrderSms, buildQuoSmsSendHandler, QUO_SMS_SEND_EVENT } from "./send";
import { ingestQuoEvent } from "./ingest";
import { parseQuoWebhook } from "./envelope";
import { registerBrowserSender, __resetBrowserTransport, type BrowserSender, type BrowserSendResult } from "./browser/transport";
import type { QuoClient } from "./client";
import type { OutboxRecord } from "@/outbox/types";

const suffix = `qbrowser-${Date.now()}`;
const CUST = "+13105558001";
const STORE_NUM = "+13105558000";
const STORE_PN = `PN_browser_${suffix}`;
let siteId: string;
const orderIds: string[] = [];

function apiClient(send = vi.fn(async (i: { from: string; to: string[] }) => ({ id: `AC_api_${Math.random()}`, status: "queued", conversationId: "CN_api", from: i.from, to: i.to }))) {
  return { client: { sendMessage: send } as unknown as QuoClient, send };
}

/** Подделка браузера: отвечает заданным исходом; если «нажимает», то зовёт beforeSend, как робот. */
function fakeBrowser(result: BrowserSendResult, pressSend = result.outcome !== "not_sent") {
  return vi.fn<BrowserSender>(async (input) => {
    if (pressSend) await input.beforeSend?.();
    return result;
  });
}

async function makeOrder(): Promise<string> {
  const o = await prisma.order.create({
    data: {
      orderNumber: `#QB-${suffix}-${orderIds.length}`, site: { connect: { id: siteId } },
      platform: "WOOCOMMERCE", source: "Website", externalCreatedAt: new Date(), deliveryDate: new Date(), deliveryWindow: "x",
      senderName: "B", senderPhone: CUST, recipientName: "R", recipientPhone: "+13105558002", addressLine: "1 A", city: "SM", zip: "90401",
      itemsTotal: new Prisma.Decimal(1), customerTotal: new Prisma.Decimal(1), paymentStatus: "PAID", orderStatus: "CONFIRMED",
    },
    select: { id: true },
  });
  orderIds.push(o.id);
  return o.id;
}

const rowsOf = (orderId: string) => prisma.orderCommunication.findMany({ where: { orderId }, orderBy: { createdAt: "asc" } });

beforeAll(async () => {
  siteId = (await prisma.site.create({ data: { name: `QB ${suffix}`, shortName: "QB", platform: "WOOCOMMERCE", quoPhoneNumberId: STORE_PN, quoPhoneNumber: STORE_NUM, quoEnabled: true } })).id;
});
afterEach(() => {
  delete process.env.QUO_BROWSER_ENABLED;
  __resetBrowserTransport();
});
afterAll(async () => {
  const comms = await prisma.orderCommunication.findMany({ where: { orderId: { in: orderIds } }, select: { id: true } });
  await prisma.outboxEvent.deleteMany({ where: { aggregateId: { in: comms.map((c) => c.id) } } });
  await prisma.orderCommunication.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  await prisma.site.deleteMany({ where: { id: siteId } });
});

describe("SMS браузером Quo — дополнение к API", () => {
  it("рубильник выключен — всё по-старому через API, браузер не трогаем", async () => {
    const orderId = await makeOrder();
    const browser = fakeBrowser({ outcome: "sent" });
    registerBrowserSender(browser);
    const { client, send } = apiClient();
    const r = await sendOrderSms(prisma, client, { orderId, target: "CUSTOMER", text: "hi", idempotencyKey: `${orderId}-off` });
    expect(r).toMatchObject({ ok: true, status: "SENT" });
    expect(browser).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("в воркере: браузер отправил — API не трогаем, запись с отметкой «браузер», а вебхук не заводит вторую", async () => {
    process.env.QUO_BROWSER_ENABLED = "true";
    const orderId = await makeOrder();
    const browser = fakeBrowser({ outcome: "sent" });
    registerBrowserSender(browser);
    const { client, send } = apiClient();
    const r = await sendOrderSms(prisma, client, { orderId, target: "CUSTOMER", text: "Your bouquet is on the way 🌸", idempotencyKey: `${orderId}-b` });
    expect(r).toMatchObject({ ok: true, status: "SENT" });
    expect(send).not.toHaveBeenCalled();
    // Тот же номер магазина (PN), что у API, и уже очищенный текст.
    expect(browser.mock.calls[0][0]).toMatchObject({ fromPhoneNumberId: STORE_PN, to: CUST, text: "Your bouquet is on the way" });
    const [row] = await rowsOf(orderId);
    expect(row).toMatchObject({ status: "SENT", providerResourceId: null, rawMetadata: { via: "browser" } });

    const ev = parseQuoWebhook({
      id: `EV_b_${suffix}`, type: "message.delivered", createdAt: new Date().toISOString(),
      data: { object: { id: `AC_b_${suffix}`, from: STORE_NUM, to: [CUST], direction: "outgoing", status: "delivered", phoneNumberId: STORE_PN, body: "Your bouquet is on the way", conversationId: "CN_b" } },
    });
    const res = await ingestQuoEvent(prisma, ev!);
    expect(res).toMatchObject({ outcome: "updated", communicationId: row.id });
    const after = await rowsOf(orderId);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ status: "DELIVERED", providerResourceId: `AC_b_${suffix}`, providerConversationId: "CN_b" });
  });

  it("до кнопки «Отправить» не дошли (вышел из аккаунта) — уходит через API", async () => {
    process.env.QUO_BROWSER_ENABLED = "true";
    const orderId = await makeOrder();
    registerBrowserSender(fakeBrowser({ outcome: "not_sent", reason: "logged_out" }));
    const { client, send } = apiClient();
    const r = await sendOrderSms(prisma, client, { orderId, target: "CUSTOMER", text: "hi", idempotencyKey: `${orderId}-n` });
    expect(r).toMatchObject({ ok: true, status: "SENT" });
    expect(send).toHaveBeenCalledTimes(1);
    const [row] = await rowsOf(orderId);
    expect(row.providerResourceId).toBeTruthy();
  });

  it("кнопку нажали, подтверждения нет — второй раз не шлём: клиент получил бы два SMS", async () => {
    process.env.QUO_BROWSER_ENABLED = "true";
    const orderId = await makeOrder();
    registerBrowserSender(fakeBrowser({ outcome: "unknown", reason: "timeout" }));
    const { client, send } = apiClient();
    const r = await sendOrderSms(prisma, client, { orderId, target: "CUSTOMER", text: "hi", idempotencyKey: `${orderId}-u` });
    expect(r).toMatchObject({ ok: true, status: "SENT" });
    expect(send).not.toHaveBeenCalled();
    const [row] = await rowsOf(orderId);
    expect(row).toMatchObject({ status: "SENT", rawMetadata: { via: "browser", unconfirmed: "timeout" } });
  });

  it("Next.js браузер не держит: поручает воркеру и дожидается исхода", async () => {
    process.env.QUO_BROWSER_ENABLED = "true"; // в этом процессе воркер не зарегистрирован — значит, Next.js
    const orderId = await makeOrder();
    const { client, send } = apiClient();
    const pending = sendOrderSms(prisma, client, { orderId, target: "CUSTOMER", text: "hi from card", idempotencyKey: `${orderId}-w` });

    // Воркер: забирает задачу и отправляет браузером.
    let task = null as Awaited<ReturnType<typeof prisma.outboxEvent.findFirst>>;
    for (let i = 0; i < 40 && !task; i++) {
      const [row] = await rowsOf(orderId);
      task = row ? await prisma.outboxEvent.findFirst({ where: { eventType: QUO_SMS_SEND_EVENT, aggregateId: row.id } }) : null;
      if (!task) await new Promise((r) => setTimeout(r, 100));
    }
    expect(task).toBeTruthy();
    const browser = fakeBrowser({ outcome: "sent" });
    await buildQuoSmsSendHandler(prisma, { client: () => client, browser: () => browser })(task as unknown as OutboxRecord);

    expect(await pending).toMatchObject({ ok: true, status: "SENT" });
    expect(browser).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
  });

  it("повтор задачи после нажатия «Отправить» (воркер упал) второе SMS не отправляет", async () => {
    const orderId = await makeOrder();
    const row = await prisma.orderCommunication.create({
      data: {
        orderId, provider: "QUO", type: "SMS", direction: "OUTBOUND", partyRole: "CUSTOMER", status: "PENDING",
        externalPhone: CUST, externalPhoneNormalized: CUST, messageText: "hi", providerPhoneNumberId: STORE_PN,
        occurredAt: new Date(), sendKey: `${orderId}-r`, rawMetadata: { via: "browser" },
      },
    });
    const browser = fakeBrowser({ outcome: "sent" });
    const { client, send } = apiClient();
    await buildQuoSmsSendHandler(prisma, { client: () => client, browser: () => browser })({ payload: { communicationId: row.id } } as unknown as OutboxRecord);
    expect(browser).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(await prisma.orderCommunication.findUnique({ where: { id: row.id } })).toMatchObject({ status: "SENT", rawMetadata: { via: "browser", unconfirmed: "worker_restarted" } });
  });
});

/**
 * Картинки (MMS) — только браузером Quo: в их API вложений нет (владелец 07.10.2026). Файл —
 * настоящий, в public/uploads, как у фото букета; после прогона удаляется.
 */
describe("картинка к SMS браузером Quo", () => {
  const PIC = `mms-${suffix}.jpg`;
  const picPath = path.join(process.cwd(), "public", "uploads", PIC);
  const FALLBACK = `https://floremart.test/bouquet/${PIC}`;
  const pic = [{ name: PIC, fallbackUrl: FALLBACK }];

  beforeAll(() => {
    mkdirSync(path.dirname(picPath), { recursive: true });
    writeFileSync(picPath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  });
  afterAll(() => rmSync(picPath, { force: true }));

  it("уходит браузером: робот получает путь к файлу, запись — картинку; вебхук картинки без текста находит ту же запись", async () => {
    process.env.QUO_BROWSER_ENABLED = "true";
    const orderId = await makeOrder();
    const browser = fakeBrowser({ outcome: "sent" });
    registerBrowserSender(browser);
    const { client, send } = apiClient();
    const r = await sendOrderSms(prisma, client, { orderId, target: "CUSTOMER", text: "", attachments: pic, idempotencyKey: `${orderId}-pic` });
    expect(r).toMatchObject({ ok: true, status: "SENT" });
    expect(send).not.toHaveBeenCalled();
    expect(browser.mock.calls[0][0]).toMatchObject({ text: "", files: [picPath] });
    const [row] = await rowsOf(orderId);
    expect(row).toMatchObject({ messageText: "", attachmentsJson: [{ url: `/api/media/${PIC}`, type: "image/jpeg", fallbackUrl: FALLBACK }] });

    const ev = parseQuoWebhook({
      id: `EV_pic_${suffix}`, type: "message.delivered", createdAt: new Date().toISOString(),
      data: { object: { id: `AC_pic_${suffix}`, from: STORE_NUM, to: [CUST], direction: "outgoing", status: "delivered", phoneNumberId: STORE_PN, body: "", media: [{ url: "https://quo.test/m/1.jpg", type: "image/jpeg" }], conversationId: "CN_pic" } },
    });
    expect(await ingestQuoEvent(prisma, ev!)).toMatchObject({ outcome: "updated", communicationId: row.id });
    const after = await rowsOf(orderId);
    expect(after).toHaveLength(1);
    // Ссылка на картинку остаётся нашей: файл живёт у нас, а не у Quo.
    expect(after[0]).toMatchObject({ status: "DELIVERED", attachmentsJson: [{ url: `/api/media/${PIC}` }] });
  });

  it("браузер недоступен — уходит через API текстом со ссылкой, и запись показывает ссылку, а не картинку", async () => {
    process.env.QUO_BROWSER_ENABLED = "true";
    const orderId = await makeOrder();
    registerBrowserSender(fakeBrowser({ outcome: "not_sent", reason: "logged_out" }));
    const { client, send } = apiClient();
    const r = await sendOrderSms(prisma, client, { orderId, target: "CUSTOMER", text: "Here is your bouquet!", attachments: pic, idempotencyKey: `${orderId}-pic-api` });
    expect(r).toMatchObject({ ok: true, status: "SENT" });
    expect(send.mock.calls[0][0]).toMatchObject({ content: `Here is your bouquet!\n${FALLBACK}` });
    const [row] = await rowsOf(orderId);
    expect(row).toMatchObject({ messageText: `Here is your bouquet!\n${FALLBACK}`, attachmentsJson: null });
  });

  it("не картинка или файла нет — отказ до записи и до Quo", async () => {
    const orderId = await makeOrder();
    const { client, send } = apiClient();
    expect(await sendOrderSms(prisma, client, { orderId, target: "CUSTOMER", text: "x", attachments: [{ name: "doc.pdf", fallbackUrl: "u" }], idempotencyKey: `${orderId}-pdf` })).toMatchObject({ ok: false, code: "attachment_unsupported" });
    expect(await sendOrderSms(prisma, client, { orderId, target: "CUSTOMER", text: "x", attachments: [{ name: `gone-${suffix}.jpg`, fallbackUrl: "u" }], idempotencyKey: `${orderId}-gone` })).toMatchObject({ ok: false, code: "attachment_missing" });
    expect(await sendOrderSms(prisma, client, { orderId, target: "CUSTOMER", text: "x", attachments: [{ name: "../.env", fallbackUrl: "u" }], idempotencyKey: `${orderId}-trav` })).toMatchObject({ ok: false, code: "attachment_unsupported" });
    expect(send).not.toHaveBeenCalled();
    expect(await rowsOf(orderId)).toHaveLength(0);
  });

  it("воркер берёт картинку из записи (сообщение из карточки, Next.js браузер не держит)", async () => {
    const orderId = await makeOrder();
    const row = await prisma.orderCommunication.create({
      data: {
        orderId, provider: "QUO", type: "SMS", direction: "OUTBOUND", partyRole: "CUSTOMER", status: "PENDING",
        externalPhone: CUST, externalPhoneNormalized: CUST, messageText: "", providerPhoneNumberId: STORE_PN,
        occurredAt: new Date(), sendKey: `${orderId}-wpic`, attachmentsJson: [{ url: `/api/media/${PIC}`, type: "image/jpeg", fallbackUrl: FALLBACK }],
      },
    });
    const browser = fakeBrowser({ outcome: "sent" });
    const { client, send } = apiClient();
    await buildQuoSmsSendHandler(prisma, { client: () => client, browser: () => browser })({ payload: { communicationId: row.id } } as unknown as OutboxRecord);
    expect(browser.mock.calls[0][0]).toMatchObject({ text: "", files: [picPath] });
    expect(send).not.toHaveBeenCalled();
    expect(await prisma.orderCommunication.findUnique({ where: { id: row.id } })).toMatchObject({ status: "SENT" });
  });
});
