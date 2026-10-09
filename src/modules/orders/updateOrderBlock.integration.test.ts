/**
 * DB integration: редактирование блоков заказа и аудит на ЖИВОЙ локальной БД. Проверяет то, что
 * нельзя проверить на моках: правка не спотыкается о системные изменения заказа, изоляцию полей
 * блока и запись OrderAudit.
 *
 * Запуск: DATABASE_URL=<local> npx vitest run --no-file-parallelism src/modules/orders/updateOrderBlock.integration.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import { prisma } from "@/lib/db";
import { updateOrderBlock } from "./updateOrderBlock";

const RUN = `occ${crypto.randomBytes(3).toString("hex")}`;
let siteId = "";
let userId = "";

async function makeOrder(key: string): Promise<{ id: string; updatedAt: string }> {
  const o = await prisma.order.create({
    data: {
      orderNumber: `${RUN}-${key}`,
      siteId,
      source: "Test",
      platform: "WOOCOMMERCE",
      externalCreatedAt: new Date("2026-07-20T00:00:00.000Z"),
      deliveryDate: new Date("2026-07-20T00:00:00.000Z"),
      deliveryWindow: "14:00–18:00",
      senderName: "Sender",
      senderPhone: "+1",
      recipientName: "Recipient",
      recipientPhone: "+2",
      addressLine: "1 St",
      city: "LA",
      zip: "90001",
      itemsTotal: "10",
      customerTotal: "10",
      cardMessage: "Hello",
      customerNote: "NOTE",
      orderStatus: "CONFIRMED",
      paymentStatus: "PAID",
    },
    select: { id: true, updatedAt: true },
  });
  return { id: o.id, updatedAt: o.updatedAt.toISOString() };
}

beforeAll(async () => {
  const site = await prisma.site.create({
    data: { name: "OCC Test", shortName: RUN.slice(0, 10).toUpperCase(), platform: "WOOCOMMERCE", connectionStatus: "CONNECTED", timezone: "America/Los_Angeles" },
    select: { id: true },
  });
  siteId = site.id;
  const u = await prisma.user.create({ data: { name: "CC", email: `${RUN}@t.test`, role: "CALL_CENTER", passwordHash: "x" }, select: { id: true } });
  userId = u.id;
});

afterAll(async () => {
  await prisma.order.deleteMany({ where: { siteId } }); // каскадом удалит OrderAudit
  await prisma.user.deleteMany({ where: { email: { startsWith: RUN } } });
  await prisma.site.deleteMany({ where: { id: siteId } });
});

describe("без сверки версии заказа", () => {
  it("систему, тронувшую заказ после открытия карточки, правка не спотыкается и чужое поле не затирает", async () => {
    // Владелец 07.10.2026: «постоянно пишет, что изменено другим пользователем, и пока несколько
    // раз не прокликаю сохранить — не уходит». Заказ трогает сама система (синк сайта, Burq, ИИ
    // дописывает заметку), а версия была одна на всю строку.
    const o = await makeOrder("touched");
    await prisma.order.update({ where: { id: o.id }, data: { customerNote: "ИИ: клиент дома после 5" } });

    const res = await updateOrderBlock({ orderId: o.id, block: "status", data: { orderStatus: "READY" }, actor: { userId, role: "OWNER" } });
    expect(res.status).toBe("ok");
    const db = await prisma.order.findUniqueOrThrow({ where: { id: o.id }, select: { orderStatus: true, customerNote: true } });
    expect(db).toEqual({ orderStatus: "READY", customerNote: "ИИ: клиент дома после 5" });
  });
});

describe("заметка: дописанное системой во время правки не теряется", () => {
  it("ИИ дописал строку сверху, пока человек правил, — строка остаётся над правкой", async () => {
    const o = await makeOrder("note-merge");
    const base = (await prisma.order.findUniqueOrThrow({ where: { id: o.id }, select: { customerNote: true } })).customerNote;
    // Человек открыл заметку; тем временем ИИ записал время от клиента сверху.
    const line = "07.10, 13:32 · Клиент (SMS): готов принять before 5pm";
    await prisma.order.update({ where: { id: o.id }, data: { customerNote: base ? `${line}\n———\n${base}` : line } });

    const res = await updateOrderBlock({ orderId: o.id, block: "cardNote", data: { customerNote: "Код домофона 1408", customerNoteBase: base }, actor: { userId, role: "CALL_CENTER" } });
    expect(res.status).toBe("ok");
    const db = await prisma.order.findUniqueOrThrow({ where: { id: o.id }, select: { customerNote: true } });
    expect(db.customerNote.startsWith(line)).toBe(true);
    expect(db.customerNote.endsWith("Код домофона 1408")).toBe(true);
  });
});

describe("изоляция полей блока", () => {
  it("сохранение блока contacts не трогает cardMessage/orderStatus/deliveryWindow", async () => {
    const o = await makeOrder("iso");
    const res = await updateOrderBlock({
      orderId: o.id, block: "contacts", 
      data: { recipientName: "New R", recipientPhone: "3105559999", addressLine: "2 St", city: "SF", zip: "94101" },
      actor: { userId, role: "CALL_CENTER" },
    });
    expect(res.status).toBe("ok");
    const db = await prisma.order.findUniqueOrThrow({ where: { id: o.id }, select: { recipientName: true, recipientPhone: true, cardMessage: true, orderStatus: true, deliveryWindow: true } });
    expect(db.recipientName).toBe("New R");
    expect(db.recipientPhone).toBe("+13105559999"); // нормализован
    expect(db.cardMessage).toBe("Hello"); // не тронут
    expect(db.orderStatus).toBe("CONFIRMED"); // не тронут
    expect(db.deliveryWindow).toBe("14:00–18:00"); // не тронут
  });
});

describe("Аудит — только изменённые поля", () => {
  it("пишет OrderAudit с блоком/ролью и только изменёнными полями (без секретов)", async () => {
    const o = await makeOrder("audit");
    await updateOrderBlock({
      orderId: o.id, block: "cardNote", 
      data: { cardMessage: "Changed", customerNote: "NOTE" }, // note не менялся
      actor: { userId, role: "CALL_CENTER" },
    });
    const audits = await prisma.orderAudit.findMany({ where: { orderId: o.id } });
    expect(audits).toHaveLength(1);
    expect(audits[0].block).toBe("cardNote");
    expect(audits[0].role).toBe("CALL_CENTER");
    expect(audits[0].userId).toBe(userId);
    // Только реально изменённое поле cardMessage; customerNote (без изменений) — отсутствует.
    expect(audits[0].changed).toEqual({ cardMessage: { from: "Hello", to: "Changed" } });
  });
});
