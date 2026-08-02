/**
 * DB integration: ledger на ЖИВОЙ базе. Проверяет ровно то, чего не покажут моки —
 * append-only триггер, unique-ключи идемпотентности и поведение при повторе.
 *
 * Запуск: DATABASE_URL=<local> npx vitest run --no-file-parallelism \
 *           src/modules/finance/ledger.integration.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import { prisma } from "@/lib/db";
import { appendEntry, reverseEntry, getFloristBalance, listLedgerEntries, LedgerError } from "./ledger";
import { recordPayment, recordAdjustment } from "./payouts";
import { setFinanceProfile, resolveProfileAt } from "./profile";
import { accrueOrder } from "./accrual";
import { orderAccrualKey } from "./ledgerRules";

const RUN = `led${crypto.randomBytes(3).toString("hex")}`;
const OWNER = { userId: "", role: "OWNER" as const };
const DAY = new Date("2026-07-24T00:00:00.000Z");

let siteId = "";
let floristId = "";
let florist2Id = "";
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
  const owner = await prisma.user.create({
    data: { name: "Owner", email: `${RUN}-owner@test.local`, role: "OWNER", passwordHash: "x" },
    select: { id: true },
  });
  OWNER.userId = owner.id;

  const site = await prisma.site.create({
    data: { name: `${RUN} site`, shortName: RUN.slice(0, 8).toUpperCase(), platform: "SHOPIFY" },
    select: { id: true },
  });
  siteId = site.id;

  floristId = await makeFlorist("Olga");
  florist2Id = await makeFlorist("Natasha");

  const order = await prisma.order.create({
    data: {
      orderNumber: `${RUN}-1001`,
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
      currentFloristId: floristId,
      priceMode: "AUTO",
      items: {
        create: [{ name: "Bouquet", productId: null, variantId: null, quantity: 1, externalPrice: "150.00", floristItemPrice: "118.00" }],
      },
    },
    select: { id: true },
  });
  orderId = order.id;
});

afterAll(async () => {
  // LedgerEntry удалить нельзя (в этом весь смысл), поэтому сначала снимаем FK у заказа,
  // а сами записи чистим единственным допустимым способом — отключив триггер в этой сессии.
  await prisma.$executeRawUnsafe(`ALTER TABLE "LedgerEntry" DISABLE TRIGGER USER`);
  await prisma.ledgerEntry.deleteMany({ where: { floristId: { in: [floristId, florist2Id] } } });
  await prisma.$executeRawUnsafe(`ALTER TABLE "LedgerEntry" ENABLE TRIGGER USER`);

  await prisma.financeAudit.deleteMany({ where: { userId: OWNER.userId } });
  await prisma.floristFinanceProfile.deleteMany({ where: { floristId: { in: [floristId, florist2Id] } } });
  await prisma.orderItem.deleteMany({ where: { orderId } });
  await prisma.order.deleteMany({ where: { siteId } });
  await prisma.florist.deleteMany({ where: { id: { in: [floristId, florist2Id] } } });
  await prisma.site.deleteMany({ where: { id: siteId } });
  await prisma.user.deleteMany({ where: { email: { startsWith: RUN } } });
});

describe("append-only на уровне БД", () => {
  it("14. UPDATE записи запрещён", async () => {
    const { id } = await appendEntry({
      floristId,
      type: "BONUS",
      amountCents: 500,
      effectiveDate: DAY,
      description: "immutability probe",
      sourceType: "MANUAL",
      idempotencyKey: `${RUN}:immutable`,
      actor: OWNER,
    });
    await expect(
      prisma.ledgerEntry.update({ where: { id }, data: { amountCents: 1 } })
    ).rejects.toThrow(/append-only/i);
  });

  it("15. DELETE записи запрещён", async () => {
    const entry = await prisma.ledgerEntry.findFirst({ where: { idempotencyKey: `${RUN}:immutable` } });
    await expect(prisma.ledgerEntry.delete({ where: { id: entry!.id } })).rejects.toThrow(/append-only/i);
  });
});

describe("начисление за доставленный заказ", () => {
  beforeAll(async () => {
    process.env.FINANCE_ACCRUAL_ENABLED = "true";
    process.env.FINANCE_ACCRUAL_START_DATE = "2026-07-01";
    await setFinanceProfile({
      floristId,
      model: "SECONDARY",
      effectiveFrom: new Date("2026-07-01T00:00:00.000Z"),
      actor: OWNER,
    });
  });

  it("1. доставленный заказ создаёт ровно одно начисление", async () => {
    const r = await accrueOrder(orderId, OWNER);
    expect(r.status).toBe("CREATED");
    if (r.status === "CREATED") expect(r.amountCents).toBe(11800);

    const count = await prisma.ledgerEntry.count({ where: { orderId, type: "ORDER_ACCRUAL" } });
    expect(count).toBe(1);
  });

  it("2. повторная обработка не создаёт дубль", async () => {
    const again = await accrueOrder(orderId, OWNER);
    expect(again.status).toBe("ALREADY_EXISTS");

    const count = await prisma.ledgerEntry.count({ where: { orderId, type: "ORDER_ACCRUAL" } });
    expect(count).toBe(1);

    // Ключ ровно тот, что зафиксирован правилом — иначе дедуп сломается при следующем релизе.
    const entry = await prisma.ledgerEntry.findUnique({ where: { idempotencyKey: orderAccrualKey(orderId, floristId) } });
    expect(entry).not.toBeNull();
  });

  it("3. не-delivered заказ не начисляется", async () => {
    const other = await prisma.order.create({
      data: {
        orderNumber: `${RUN}-1002`,
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
        itemsTotal: "100.00",
        customerTotal: "100.00",
        floristTotal: "80.00",
        platform: "SHOPIFY",
        orderStatus: "READY",
        currentFloristId: floristId,
      },
      select: { id: true },
    });
    const r = await accrueOrder(other.id, OWNER);
    expect(r).toEqual({ status: "SKIPPED", reason: "NOT_DELIVERED" });
  });

  it("5. заказ без цены флориста не начисляется", async () => {
    const noPrice = await prisma.order.create({
      data: {
        orderNumber: `${RUN}-1003`,
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
        itemsTotal: "100.00",
        customerTotal: "100.00",
        floristTotal: "0.00",
        platform: "SHOPIFY",
        orderStatus: "DELIVERED",
        currentFloristId: floristId,
      },
      select: { id: true },
    });
    const r = await accrueOrder(noPrice.id, OWNER);
    expect(r).toEqual({ status: "SKIPPED", reason: "FLORIST_PRICE_MISSING" });
    // Полная цена клиента (100.00) в книгу не попала.
    expect(await prisma.ledgerEntry.count({ where: { orderId: noPrice.id } })).toBe(0);
  });

  it("6. доставленный заказ без флориста не начисляется", async () => {
    const noFlorist = await prisma.order.create({
      data: {
        orderNumber: `${RUN}-1004`,
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
        itemsTotal: "100.00",
        customerTotal: "100.00",
        floristTotal: "0.00",
        platform: "SHOPIFY",
        orderStatus: "DELIVERED",
      },
      select: { id: true },
    });
    const r = await accrueOrder(noFlorist.id, OWNER);
    expect(r).toEqual({ status: "SKIPPED", reason: "NO_FLORIST" });
  });

  it("основной флорист на этом этапе не начисляется", async () => {
    await setFinanceProfile({
      floristId: florist2Id,
      model: "PRIMARY",
      effectiveFrom: new Date("2026-07-01T00:00:00.000Z"),
      actor: OWNER,
    });
    const primaryOrder = await prisma.order.create({
      data: {
        orderNumber: `${RUN}-1005`,
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
        itemsTotal: "200.00",
        customerTotal: "200.00",
        floristTotal: "150.00",
        platform: "SHOPIFY",
        orderStatus: "DELIVERED",
        currentFloristId: florist2Id,
      },
      select: { id: true },
    });
    const r = await accrueOrder(primaryOrder.id, OWNER);
    expect(r).toEqual({ status: "SKIPPED", reason: "PRIMARY_MODEL_STAGE3" });
  });
});

describe("выплаты и корректировки", () => {
  it("10. бонус увеличивает остаток", async () => {
    await recordAdjustment({
      floristId,
      kind: "BONUS",
      amountCents: 2000,
      effectiveDate: DAY,
      description: "Срочный заказ",
      token: `${RUN}-bonus`,
      actor: OWNER,
    });
    const b = await getFloristBalance(floristId);
    // 118.00 начисление + 5.00 проба неизменяемости + 20.00 бонус
    expect(b.bonusCents).toBe(2500);
    expect(b.outstandingCents).toBe(14300);
  });

  it("11. удержание требует причину и уменьшает остаток", async () => {
    await expect(
      recordAdjustment({
        floristId,
        kind: "DEDUCTION",
        amountCents: 1000,
        effectiveDate: DAY,
        description: "Испорченный букет",
        token: `${RUN}-ded-bad`,
        actor: OWNER,
      })
    ).rejects.toThrow(LedgerError);

    await recordAdjustment({
      floristId,
      kind: "DEDUCTION",
      amountCents: 1000,
      effectiveDate: DAY,
      description: "Испорченный букет",
      comment: "Переделка за счёт мастерской",
      token: `${RUN}-ded`,
      actor: OWNER,
    });
    const b = await getFloristBalance(floristId);
    expect(b.deductionCents).toBe(1000);
    expect(b.outstandingCents).toBe(13300);
  });

  it("7. частичная выплата оставляет остаток", async () => {
    await recordPayment({
      floristId,
      amountCents: 10000,
      effectiveDate: DAY,
      token: `${RUN}-pay1`,
      actor: OWNER,
    });
    const b = await getFloristBalance(floristId);
    expect(b.paidCents).toBe(10000);
    expect(b.outstandingCents).toBe(3300);
  });

  it("повторная отправка той же формы не создаёт вторую выплату", async () => {
    await recordPayment({
      floristId,
      amountCents: 10000,
      effectiveDate: DAY,
      token: `${RUN}-pay1`,
      actor: OWNER,
    });
    const b = await getFloristBalance(floristId);
    expect(b.paidCents).toBe(10000);
  });

  it("9. переплата требует подтверждения", async () => {
    await expect(
      recordPayment({
        floristId,
        amountCents: 999999,
        effectiveDate: DAY,
        token: `${RUN}-over-bad`,
        actor: OWNER,
      })
    ).rejects.toThrow(/больше остатка/i);

    await recordPayment({
      floristId,
      amountCents: 5000,
      effectiveDate: DAY,
      token: `${RUN}-over`,
      confirmOverpayment: true,
      actor: OWNER,
    });
    const b = await getFloristBalance(floristId);
    expect(b.outstandingCents).toBe(-1700);
  });

  it("13. отмена выплаты возвращает долг и не трогает оригинал", async () => {
    const payment = await prisma.ledgerEntry.findUnique({ where: { idempotencyKey: `MANUAL:PAYMENT:${floristId}:${RUN}-over` } });
    const before = await getFloristBalance(floristId);

    await reverseEntry({ entryId: payment!.id, comment: "Ошиблись суммой", actor: OWNER });

    const after = await getFloristBalance(floristId);
    expect(after.outstandingCents).toBe(before.outstandingCents + 5000);

    // Оригинал остался на месте с той же суммой — история не переписана.
    const original = await prisma.ledgerEntry.findUnique({ where: { id: payment!.id } });
    expect(original?.amountCents).toBe(5000);
  });

  it("отменить дважды нельзя", async () => {
    const payment = await prisma.ledgerEntry.findUnique({ where: { idempotencyKey: `MANUAL:PAYMENT:${floristId}:${RUN}-over` } });
    const r = await reverseEntry({ entryId: payment!.id, comment: "второй раз", actor: OWNER });
    expect(r.created).toBe(false);
    const reversals = await prisma.ledgerEntry.count({ where: { reversedEntryId: payment!.id } });
    expect(reversals).toBe(1);
  });

  it("8. полная выплата обнуляет остаток", async () => {
    const b = await getFloristBalance(floristId);
    await recordPayment({
      floristId,
      amountCents: b.outstandingCents,
      effectiveDate: DAY,
      token: `${RUN}-payfull`,
      actor: OWNER,
    });
    const after = await getFloristBalance(floristId);
    expect(after.outstandingCents).toBe(0);
  });
});

describe("профиль флориста", () => {
  it("резолвится на дату, а не «как сейчас»", async () => {
    const inJuly = await resolveProfileAt(floristId, new Date("2026-07-15T00:00:00.000Z"));
    expect(inJuly?.model).toBe("SECONDARY");

    const beforeStart = await resolveProfileAt(floristId, new Date("2026-06-15T00:00:00.000Z"));
    expect(beforeStart).toBeNull();
  });

  it("смена модели закрывает прежний период, а не переписывает его", async () => {
    await setFinanceProfile({
      floristId,
      model: "PRIMARY",
      effectiveFrom: new Date("2026-09-01T00:00:00.000Z"),
      actor: OWNER,
    });

    // Июльский заказ по-прежнему считается по июльским правилам.
    const july = await resolveProfileAt(floristId, new Date("2026-07-15T00:00:00.000Z"));
    expect(july?.model).toBe("SECONDARY");
    const september = await resolveProfileAt(floristId, new Date("2026-09-15T00:00:00.000Z"));
    expect(september?.model).toBe("PRIMARY");
  });
});

describe("история операций", () => {
  it("фильтр по типу и пагинация работают вместе", async () => {
    const payments = await listLedgerEntries(floristId, { types: ["PAYMENT"], perPage: 1, page: 1 });
    expect(payments.entries).toHaveLength(1);
    expect(payments.entries[0].type).toBe("PAYMENT");
    expect(payments.total).toBeGreaterThan(1);
  });

  it("отменённая операция помечена, а не спрятана", async () => {
    const all = await listLedgerEntries(floristId, { perPage: 200 });
    const reversed = all.entries.filter((e) => e.isReversed);
    const reversals = all.entries.filter((e) => e.isReversal);
    expect(reversed.length).toBeGreaterThan(0);
    expect(reversals.length).toBeGreaterThan(0);
  });
});
