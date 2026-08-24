/**
 * Пометка о работе с клиентом. Требует живой БД в DATABASE_URL.
 *
 * Проверяется то, из-за чего пометка была бы бесполезна или вредна: «попросить отзыв» обязано
 * поставить задачу оператору, «не писать» — не должно её ставить, а повторное нажатие того же
 * значения не должно ни плодить задачи, ни засорять аудит.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/lib/db";
import { setOrderMarketingMark } from "./marketingMark";

const RUN = `mark-${Date.now()}`;
let siteId = "";
let actor = { userId: "", role: "OWNER" as const };
const orderIds: string[] = [];

async function makeOrder() {
  const order = await prisma.order.create({
    data: {
      orderNumber: `${RUN}-${orderIds.length}`,
      siteId,
      platform: "SHOPIFY",
      source: "MANUAL",
      externalCreatedAt: new Date("2026-08-19T10:00:00Z"),
      deliveryDate: new Date("2026-08-20T00:00:00Z"),
      deliveryWindow: "12:00 – 16:00",
      senderName: "Заказчик",
      senderPhone: "+14245550000",
      recipientName: "Получатель",
      recipientPhone: "+14245551111",
      addressLine: "1 Main St",
      city: "LA",
      zip: "90001",
      itemsTotal: "100.00",
      customerTotal: "100.00",
    },
  });
  orderIds.push(order.id);
  return order.id;
}

const tasksFor = (orderId: string) =>
  prisma.outboxEvent.count({ where: { aggregateId: orderId, eventType: "telegram.notify" } });

beforeAll(async () => {
  const site = await prisma.site.create({
    data: { name: `${RUN}-site`, shortName: "MRK", platform: "SHOPIFY", connectionStatus: "CONNECTED" },
  });
  siteId = site.id;
  const user = await prisma.user.create({
    data: { name: "Владелец", email: `${RUN}@example.com`, role: "OWNER", passwordHash: "x" },
  });
  actor = { userId: user.id, role: "OWNER" };
});

afterAll(async () => {
  await prisma.outboxEvent.deleteMany({ where: { aggregateId: { in: orderIds } } }).catch(() => {});
  await prisma.orderAudit.deleteMany({ where: { orderId: { in: orderIds } } }).catch(() => {});
  await prisma.order.deleteMany({ where: { siteId } }).catch(() => {});
  await prisma.user.delete({ where: { id: actor.userId } }).catch(() => {});
  await prisma.site.delete({ where: { id: siteId } }).catch(() => {});
});

describe("задача колл-центру", () => {
  it("«попросить отзыв» ставит задачу оператору", async () => {
    const id = await makeOrder();
    const res = await setOrderMarketingMark(id, "ASK_REVIEW", actor);

    expect(res).toMatchObject({ ok: true, mark: "ASK_REVIEW" });
    expect(await tasksFor(id)).toBe(1);
  });

  it("«не писать» задачу НЕ ставит", async () => {
    // Это запрет на письма, а не повод дёргать оператора.
    const id = await makeOrder();
    await setOrderMarketingMark(id, "MUTED", actor);

    expect(await tasksFor(id)).toBe(0);
  });

  it("повторное то же значение задачу не дублирует", async () => {
    const id = await makeOrder();
    await setOrderMarketingMark(id, "ASK_REVIEW", actor);
    await setOrderMarketingMark(id, "ASK_REVIEW", actor);

    expect(await tasksFor(id)).toBe(1);
    expect(await prisma.orderAudit.count({ where: { orderId: id } })).toBe(1);
  });

  it("снятие пометки возвращает заказ в обычное состояние", async () => {
    const id = await makeOrder();
    await setOrderMarketingMark(id, "MUTED", actor);
    const res = await setOrderMarketingMark(id, null, actor);

    expect(res).toMatchObject({ ok: true, mark: null });
    expect((await prisma.order.findUniqueOrThrow({ where: { id } })).marketingMark).toBeNull();
  });

  it("переключение с «не писать» на «попросить отзыв» ставит задачу", async () => {
    const id = await makeOrder();
    await setOrderMarketingMark(id, "MUTED", actor);
    await setOrderMarketingMark(id, "ASK_REVIEW", actor);

    expect(await tasksFor(id)).toBe(1);
  });
});
