/**
 * Подсказка «получатель благодарит — попросить отзыв?». Требует живой БД в DATABASE_URL.
 *
 * Подсказка уходит владельцу ровно тогда, когда просить уместно: заказ доставлен, пишет именно
 * получатель (свой номер, не заказчика), запроса ему ещё нет. И одна на заказ: получатель может
 * поблагодарить дважды.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/lib/db";
import { suggestRecipientReview } from "./reviewSuggest";
import { createReviewRequest } from "@/modules/reviews/requests";

const RUN = `rsug-${Date.now()}`;
const N = String(Date.now()).slice(-3);
let siteId = "";
let seq = 0;
const site = { aiDryRun: false };

async function makeOrder(opts: { delivered?: boolean; samePhone?: boolean } = {}) {
  seq += 1;
  const sender = `+1213${N}${String(seq).padStart(2, "0")}1`;
  const recipient = opts.samePhone ? sender : `+1213${N}${String(seq).padStart(2, "0")}2`;
  return prisma.order.create({
    data: {
      orderNumber: `${RUN}-${seq}`, siteId, platform: "SHOPIFY", source: "MANUAL",
      externalCreatedAt: new Date("2026-10-01T10:00:00Z"), deliveryDate: new Date("2026-10-02T00:00:00Z"), deliveryWindow: "12:00 - 16:00",
      orderStatus: opts.delivered === false ? "CONFIRMED" : "DELIVERED",
      senderName: "John", senderPhone: sender, recipientName: "Maria", recipientPhone: recipient,
      addressLine: "1 Main St", city: "LA", zip: "90210", itemsTotal: "100.00", customerTotal: "100.00",
    },
    select: { id: true, orderStatus: true, senderPhone: true, recipientPhone: true },
  });
}

const suggestions = (orderId: string) =>
  prisma.outboxEvent.findMany({ where: { aggregateId: orderId, idempotencyKey: { startsWith: "telegram:assistant.review_suggest:" } } });
const from = (phone: string, partyRole = "UNKNOWN") => ({ externalPhoneNormalized: phone, partyRole });

beforeAll(async () => {
  const s = await prisma.site.create({ data: { name: `${RUN}-site`, shortName: "RSG", platform: "SHOPIFY", connectionStatus: "CONNECTED" } });
  siteId = s.id;
});

afterAll(async () => {
  const orders = await prisma.order.findMany({ where: { siteId }, select: { id: true } });
  await prisma.outboxEvent.deleteMany({ where: { aggregateId: { in: orders.map((o) => o.id) } } }).catch(() => {});
  await prisma.orderReviewRequest.deleteMany({ where: { order: { siteId } } }).catch(() => {});
  await prisma.order.deleteMany({ where: { siteId } }).catch(() => {});
  await prisma.site.delete({ where: { id: siteId } }).catch(() => {});
});

describe("подсказка владельцу попросить отзыв у получателя", () => {
  it("получатель благодарит после доставки — одна подсказка, даже если поблагодарил дважды", async () => {
    const o = await makeOrder();
    expect(await suggestRecipientReview(prisma, o, site, from(o.recipientPhone), "Thank you so much!")).toBe(true);
    await suggestRecipientReview(prisma, o, site, from(o.recipientPhone), "They are gorgeous");
    const rows = await suggestions(o.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].payload).toMatchObject({ type: "assistant.review_suggest", context: { quote: "Thank you so much!" } });
  });

  it("благодарит заказчик — не подсказываем: у него отзыв просят пометкой", async () => {
    const o = await makeOrder();
    expect(await suggestRecipientReview(prisma, o, site, from(o.senderPhone), "Thank you!")).toBe(false);
    expect(await suggestions(o.id)).toHaveLength(0);
  });

  it("заказ ещё не доставлен — рано", async () => {
    const o = await makeOrder({ delivered: false });
    expect(await suggestRecipientReview(prisma, o, site, from(o.recipientPhone), "Thank you!")).toBe(false);
  });

  it("один номер на двоих — получатель и есть заказчик", async () => {
    const o = await makeOrder({ samePhone: true });
    expect(await suggestRecipientReview(prisma, o, site, from(o.recipientPhone, "RECIPIENT"), "Thank you!")).toBe(false);
  });

  it("запрос получателю уже есть — второй раз не предлагаем", async () => {
    const o = await makeOrder();
    await createReviewRequest(prisma, o.id, null, "RECIPIENT");
    expect(await suggestRecipientReview(prisma, o, site, from(o.recipientPhone), "Thank you!")).toBe(false);
  });
});
