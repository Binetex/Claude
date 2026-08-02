/**
 * Права доступа к финансам и поведение при изменении цены после начисления.
 *
 * Ключевая проверка — «подмена floristId через URL». Проверяется она не имитацией запроса,
 * а СТРУКТУРНО: у маршрута кабинета флориста нет сегмента с id, и ни одна функция чтения
 * на этой странице не принимает floristId снаружи. Тест фиксирует оба факта, потому что
 * именно их поломка вернула бы дыру.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { prisma } from "@/lib/db";
import { appendEntry, getFloristBalance, listLedgerEntries } from "./ledger";
import { recordAdjustment, recordPayment } from "./payouts";
import { setFinanceProfile } from "./profile";
import { accrueOrder, reaccrueOrder } from "./accrual";
import { setManualFloristPrice } from "@/modules/assignments/service";

const RUN = `acc${crypto.randomBytes(3).toString("hex")}`;
const OWNER = { userId: "", role: "OWNER" as const };
const DAY = new Date("2026-07-24T00:00:00.000Z");

let siteId = "";
let olgaId = "";
let natashaId = "";
let callCenterId = "";
let orderId = "";

async function makeFlorist(name: string): Promise<string> {
  const user = await prisma.user.create({
    data: { name, email: `${RUN}-${name}@test.local`, role: "FLORIST", passwordHash: "x" },
    select: { id: true },
  });
  const f = await prisma.florist.create({ data: { userId: user.id }, select: { id: true } });
  return f.id;
}

beforeAll(async () => {
  process.env.FINANCE_ACCRUAL_ENABLED = "true";
  process.env.FINANCE_ACCRUAL_START_DATE = "2026-07-01";

  const owner = await prisma.user.create({
    data: { name: "Owner", email: `${RUN}-owner@test.local`, role: "OWNER", passwordHash: "x" },
    select: { id: true },
  });
  OWNER.userId = owner.id;

  const cc = await prisma.user.create({
    data: { name: "CC", email: `${RUN}-cc@test.local`, role: "CALL_CENTER", passwordHash: "x" },
    select: { id: true },
  });
  callCenterId = cc.id;

  const site = await prisma.site.create({
    data: { name: `${RUN} site`, shortName: RUN.slice(0, 8).toUpperCase(), platform: "SHOPIFY" },
    select: { id: true },
  });
  siteId = site.id;

  olgaId = await makeFlorist("Olga");
  natashaId = await makeFlorist("Natasha");

  for (const id of [olgaId, natashaId]) {
    await setFinanceProfile({
      floristId: id,
      model: "SECONDARY",
      effectiveFrom: new Date("2026-07-01T00:00:00.000Z"),
      actor: OWNER,
    });
  }

  const order = await prisma.order.create({
    data: {
      orderNumber: `${RUN}-2001`,
      siteId,
      source: "Website",
      externalCreatedAt: DAY,
      deliveryDate: DAY,
      deliveryWindow: "14:00 – 18:00",
      senderName: "S",
      senderPhone: "+15550000000",
      recipientName: "R",
      recipientPhone: "+15550000001",
      addressLine: "1 Main St",
      city: "LA",
      zip: "90001",
      itemsTotal: "150.00",
      customerTotal: "150.00",
      floristTotal: "118.00",
      platform: "SHOPIFY",
      orderStatus: "DELIVERED",
      currentFloristId: olgaId,
      priceMode: "AUTO",
      items: {
        create: [{ name: "Bouquet", quantity: 1, externalPrice: "150.00", floristItemPrice: "118.00" }],
      },
    },
    select: { id: true },
  });
  orderId = order.id;

  // Каждому флористу — своя запись, чтобы проверять изоляцию выдачи.
  await appendEntry({
    floristId: natashaId,
    type: "BONUS",
    amountCents: 3000,
    effectiveDate: DAY,
    description: "Бонус Наташе",
    sourceType: "MANUAL",
    idempotencyKey: `${RUN}:natasha-bonus`,
    actor: OWNER,
  });
});

afterAll(async () => {
  await prisma.$executeRawUnsafe(`ALTER TABLE "LedgerEntry" DISABLE TRIGGER USER`);
  await prisma.ledgerEntry.deleteMany({ where: { floristId: { in: [olgaId, natashaId] } } });
  await prisma.$executeRawUnsafe(`ALTER TABLE "LedgerEntry" ENABLE TRIGGER USER`);

  await prisma.financeAudit.deleteMany({ where: { userId: OWNER.userId } });
  await prisma.floristFinanceProfile.deleteMany({ where: { floristId: { in: [olgaId, natashaId] } } });
  await prisma.orderItem.deleteMany({ where: { orderId } });
  await prisma.order.deleteMany({ where: { siteId } });
  await prisma.florist.deleteMany({ where: { id: { in: [olgaId, natashaId] } } });
  await prisma.site.deleteMany({ where: { id: siteId } });
  await prisma.user.deleteMany({ where: { email: { startsWith: RUN } } });
});

describe("изоляция данных между флористами", () => {
  it("16/17. флорист видит только свои записи", async () => {
    await accrueOrder(orderId, OWNER);

    const olga = await listLedgerEntries(olgaId, { perPage: 100 });
    const natasha = await listLedgerEntries(natashaId, { perPage: 100 });

    expect(olga.entries.every((e) => e.description !== "Бонус Наташе")).toBe(true);
    expect(natasha.entries).toHaveLength(1);
    expect(natasha.entries[0].description).toBe("Бонус Наташе");

    const olgaBalance = await getFloristBalance(olgaId);
    const natashaBalance = await getFloristBalance(natashaId);
    expect(olgaBalance.outstandingCents).toBe(11800);
    expect(natashaBalance.outstandingCents).toBe(3000);
  });

  it("19. подменить floristId в кабинете флориста структурно негде", () => {
    const routeDir = path.join(process.cwd(), "src/app/dashboard/(florist)/f/finance");
    const entries = fs.readdirSync(routeDir);
    // Динамического сегмента нет — значит и подставить чужой id в URL нельзя.
    expect(entries.filter((e) => e.startsWith("["))).toHaveLength(0);

    const source = fs.readFileSync(path.join(routeDir, "page.tsx"), "utf8");
    // Идентификатор берётся из сессии...
    expect(source).toContain("requireFlorist()");
    expect(source).toContain("user.floristId");
    // ...и никогда из параметров маршрута.
    expect(source).not.toMatch(/params.*floristId/);
    expect(source).not.toMatch(/searchParams.*floristId/);
  });

  it("18. колл-центр не проходит гейт кабинета флориста", () => {
    // requireFlorist → requireRole("FLORIST"): у CALL_CENTER роль другая, его уводит
    // на /dashboard/cc. Проверяем сам контракт rbac, а не рендер страницы.
    const rbac = fs.readFileSync(path.join(process.cwd(), "src/lib/rbac.ts"), "utf8");
    expect(rbac).toMatch(/requireFlorist[\s\S]*requireRole\("FLORIST"\)/);
    const layout = fs.readFileSync(
      path.join(process.cwd(), "src/app/dashboard/(owner)/layout.tsx"),
      "utf8"
    );
    expect(layout).toContain('requireRole("OWNER")');
  });

  it("роль не-владельца не может писать в книгу", async () => {
    await expect(
      recordPayment({
        floristId: olgaId,
        amountCents: 1000,
        effectiveDate: DAY,
        token: `${RUN}-cc-pay`,
        actor: { userId: callCenterId, role: "CALL_CENTER" },
      })
    ).rejects.toThrow(/только владельцу/i);

    await expect(
      recordAdjustment({
        floristId: olgaId,
        kind: "BONUS",
        amountCents: 1000,
        effectiveDate: DAY,
        description: "нельзя",
        token: `${RUN}-cc-bonus`,
        actor: { userId: callCenterId, role: "CALL_CENTER" },
      })
    ).rejects.toThrow(/только владельцу/i);
  });
});

describe("20. изменение цены после начисления", () => {
  it("создаёт сторно и новое начисление, не переписывая историю", async () => {
    const before = await prisma.ledgerEntry.findMany({ where: { orderId, type: "ORDER_ACCRUAL" } });
    expect(before).toHaveLength(1);
    expect(before[0].amountCents).toBe(11800);

    await setManualFloristPrice(orderId, 130);
    const result = await reaccrueOrder(orderId, OWNER, "Владелец изменил цену флориста по заказу");

    expect(result.status).toBe("CORRECTED");
    if (result.status === "CORRECTED") {
      expect(result.fromCents).toBe(11800);
      expect(result.toCents).toBe(13000);
    }

    // Оригинал на месте и с прежней суммой.
    const original = await prisma.ledgerEntry.findUnique({ where: { id: before[0].id } });
    expect(original?.amountCents).toBe(11800);

    // Сторно ссылается на оригинал и объясняет себя.
    const reversal = await prisma.ledgerEntry.findUnique({ where: { reversedEntryId: before[0].id } });
    expect(reversal?.type).toBe("CORRECTION");
    expect(reversal?.direction).toBe("DEBIT");
    expect(reversal?.comment).toMatch(/изменил цену/i);

    // Итог книги равен новой сумме, а не сумме обеих.
    const balance = await getFloristBalance(olgaId);
    expect(balance.outstandingCents).toBe(13000);

    // Записей по заказу стало три: начисление, сторно, новое начисление.
    const all = await prisma.ledgerEntry.findMany({ where: { orderId } });
    expect(all).toHaveLength(3);
  });

  it("повторный пересчёт без изменений не плодит записей", async () => {
    const r = await reaccrueOrder(orderId, OWNER, "повтор");
    expect(r.status).toBe("UNCHANGED");
    const all = await prisma.ledgerEntry.findMany({ where: { orderId } });
    expect(all).toHaveLength(3);
  });

  it("переназначение доставленного заказа переносит деньги другому флористу", async () => {
    await prisma.order.update({ where: { id: orderId }, data: { currentFloristId: natashaId } });
    const r = await reaccrueOrder(orderId, OWNER, "Владелец переназначил флориста");
    expect(r.status).toBe("CORRECTED");

    const olga = await getFloristBalance(olgaId);
    const natasha = await getFloristBalance(natashaId);
    expect(olga.outstandingCents).toBe(0);
    // 30.00 бонус + 130.00 перенесённое начисление
    expect(natasha.outstandingCents).toBe(16000);
  });

  it("12. FinanceAudit фиксирует каждую операцию книги", async () => {
    const audits = await prisma.financeAudit.findMany({
      where: { entity: "LedgerEntry", userId: OWNER.userId },
    });
    const ledgerCount = await prisma.ledgerEntry.count({ where: { floristId: { in: [olgaId, natashaId] } } });
    expect(audits.length).toBe(ledgerCount);
  });
});
