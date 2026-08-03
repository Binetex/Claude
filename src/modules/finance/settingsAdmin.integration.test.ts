/**
 * DB integration: исправление и удаление настроек расчёта.
 *
 * Проверяется то, что нельзя проверить в отрыве от БД: правка настройки пересчитывает
 * дни и двигает заработок, удаление возвращает день в разбор, а история значений остаётся
 * в FinanceAudit после того, как сама запись исчезла.
 *
 * Запуск: DATABASE_URL=<local> npx vitest run --no-file-parallelism \
 *           src/modules/finance/settingsAdmin.integration.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import { prisma } from "@/lib/db";
import { computeDayShare } from "./dayFinance";
import { setFinanceProfile } from "./profile";
import { floristBalance } from "./balance";
import { fixConsumablesRate, fixDailyFlowerExpense, fixDeliveryActualCost, fixSiteFeeModel, fixOwnerTaxPolicy } from "./fix";
import {
  correctSetting,
  deleteSetting,
  listSettingRecords,
  previewSettingChange,
  settingHistory,
  SettingsAdminError,
} from "./settingsAdmin";

const RUN = `sad${crypto.randomBytes(3).toString("hex")}`;
const OWNER = { userId: "", role: "OWNER" as const };
const FLORIST_ACTOR = { userId: "", role: "FLORIST" as const };
const DAY = new Date("2026-07-28T00:00:00.000Z");
const SHARE_START = new Date("2026-07-01T00:00:00.000Z");
const NOW = new Date("2026-07-29T12:00:00.000Z");

let siteId = "";
let productId = "";
let floristId = "";
let profileId = "";
let orderA = "";
let orderB = "";

async function makeOrder(n: string, cents: number): Promise<string> {
  const o = await prisma.order.create({
    data: {
      orderNumber: `${RUN}-${n}`,
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
      itemsTotal: (cents / 100).toFixed(2),
      tax: "10.00",
      tip: "5.00",
      deliveryCustomerCost: "20.00",
      customerTotal: ((cents + 3500) / 100).toFixed(2),
      platform: "SHOPIFY",
      orderStatus: "DELIVERED",
      currentFloristId: floristId,
      items: { create: [{ name: "Bouquet", quantity: 1, externalPrice: (cents / 100).toFixed(2), productId }] },
    },
    select: { id: true },
  });
  return o.id;
}

const consumablesRows = () => prisma.consumablesRate.findMany({ where: { siteId: null } });

beforeAll(async () => {
  process.env.FINANCE_PRIMARY_SHARE_START_DATE = "2026-07-01";

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

  const product = await prisma.product.create({
    data: { name: `${RUN} bouquet`, siteId, externalId: `${RUN}-p`, financialType: "FLOWER_PRODUCT" },
    select: { id: true },
  });
  productId = product.id;

  const user = await prisma.user.create({
    data: { name: "Nastya", email: `${RUN}-primary@test.local`, role: "FLORIST", passwordHash: "x" },
    select: { id: true },
  });
  FLORIST_ACTOR.userId = user.id;
  const florist = await prisma.florist.create({ data: { userId: user.id }, select: { id: true } });
  floristId = florist.id;

  profileId = (
    await setFinanceProfile({ floristId, model: "PRIMARY", effectiveFrom: SHARE_START, sharePercentBp: 6660, actor: OWNER })
  ).createdId;

  orderA = await makeOrder("A", 10000);
  orderB = await makeOrder("B", 20000);

  await fixConsumablesRate({ siteId: null, amountCents: 500, actor: OWNER, now: NOW });
  await fixSiteFeeModel({ siteId, percentBp: 290, fixedCents: 30, actor: OWNER, now: NOW });
  await fixOwnerTaxPolicy({ siteId: null, actualShareBp: 2000, actor: OWNER, now: NOW });
  await fixDeliveryActualCost({ orderId: orderA, amountCents: 1000, actor: OWNER, now: NOW });
  await fixDeliveryActualCost({ orderId: orderB, amountCents: 1000, actor: OWNER, now: NOW });
  await fixDailyFlowerExpense({ expenseDay: DAY, amountCents: 6000, actor: OWNER, now: NOW });
});

afterAll(async () => {
  delete process.env.FINANCE_PRIMARY_SHARE_START_DATE;
  await prisma.$executeRawUnsafe(`ALTER TABLE "LedgerEntry" DISABLE TRIGGER USER`);
  await prisma.ledgerEntry.deleteMany({ where: { floristId } });
  await prisma.$executeRawUnsafe(`ALTER TABLE "LedgerEntry" ENABLE TRIGGER USER`);

  await prisma.financeIssue.deleteMany({ where: { OR: [{ siteId }, { floristId }] } });
  await prisma.financeAudit.deleteMany({ where: { userId: { in: [OWNER.userId, FLORIST_ACTOR.userId] } } });
  await prisma.dailyFlowerExpense.deleteMany({ where: { financeProfileId: profileId } });
  await prisma.consumablesRate.deleteMany({ where: { siteId: null } });
  await prisma.ownerTaxPolicy.deleteMany({ where: { siteId: null } });
  await prisma.siteAcquiringFeeModel.deleteMany({ where: { siteId } });
  await prisma.floristFinanceProfile.deleteMany({ where: { floristId } });
  await prisma.orderItem.deleteMany({ where: { order: { siteId } } });
  await prisma.order.deleteMany({ where: { siteId } });
  await prisma.product.deleteMany({ where: { siteId } });
  await prisma.florist.deleteMany({ where: { id: floristId } });
  await prisma.site.deleteMany({ where: { id: siteId } });
  await prisma.user.deleteMany({ where: { email: { startsWith: RUN } } });
});

describe("права", () => {
  it("править настройки может только владелец", async () => {
    const [rate] = await consumablesRows();
    await expect(
      correctSetting({
        entity: "CONSUMABLES_RATE",
        id: rate.id,
        values: { entity: "CONSUMABLES_RATE", amountCents: 700 },
        reason: "нет",
        actor: FLORIST_ACTOR,
        now: NOW,
      })
    ).rejects.toThrow(/только владелец/);
  });

  it("причина обязательна и у исправления, и у удаления", async () => {
    const [rate] = await consumablesRows();
    await expect(
      correctSetting({
        entity: "CONSUMABLES_RATE",
        id: rate.id,
        values: { entity: "CONSUMABLES_RATE", amountCents: 700 },
        reason: "   ",
        actor: OWNER,
        now: NOW,
      })
    ).rejects.toThrow(/причину/);
    await expect(
      deleteSetting({ entity: "CONSUMABLES_RATE", id: rate.id, reason: "", actor: OWNER, now: NOW })
    ).rejects.toThrow(/причину/);
  });
});

describe("предпросмотр правки", () => {
  it("показывает заказы и будущую долю, ничего не записывая", async () => {
    const [rate] = await consumablesRows();
    const daysBefore = await prisma.dayFinance.findMany({ select: { day: true, distributableCents: true } });
    const ledgerBefore = await prisma.ledgerEntry.count({ where: { floristId } });

    const p = await previewSettingChange({
      entity: "CONSUMABLES_RATE",
      id: rate.id,
      op: "CORRECT",
      values: { entity: "CONSUMABLES_RATE", amountCents: 1500 },
      now: NOW,
    });

    expect(p.affectedDays).toBe(1);
    expect(p.affectedOrders).toBe(2);
    expect(p.days[0].ordersChanged).toBe(2);
    // Расходники выросли на $10 на каждый из двух заказов — прибыль и доля падают.
    expect(p.shareAfterCents).toBeLessThan(p.shareBeforeCents);
    expect(p.daysChanged).toBe(1);
    expect(p.days[0].orderNumbers).toHaveLength(2);

    expect(await prisma.dayFinance.findMany({ select: { day: true, distributableCents: true } })).toEqual(daysBefore);
    expect(await prisma.ledgerEntry.count({ where: { floristId } })).toBe(ledgerBefore);
  });

  it("предсказанная доля совпадает с тем, что получится на самом деле", async () => {
    const [rate] = await consumablesRows();
    const p = await previewSettingChange({
      entity: "CONSUMABLES_RATE",
      id: rate.id,
      op: "CORRECT",
      values: { entity: "CONSUMABLES_RATE", amountCents: 800 },
      now: NOW,
    });

    await correctSetting({
      entity: "CONSUMABLES_RATE",
      id: rate.id,
      values: { entity: "CONSUMABLES_RATE", amountCents: 800 },
      reason: "ошиблись в ставке",
      actor: OWNER,
      now: NOW,
    });

    expect((await computeDayShare(profileId, DAY))!.shareCents).toBe(p.shareAfterCents);
  });
});

describe("правка настройки", () => {
  it("переписывает ту же строку, а не заводит вторую", async () => {
    const rows = await consumablesRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].amountCents).toBe(800);
  });

  it("заработок меняется сам, без единой записи в книге", async () => {
    const computed = await computeDayShare(profileId, DAY);
    expect((await floristBalance(floristId)).earnedCents).toBe(computed!.shareCents);
    expect(await prisma.ledgerEntry.count({ where: { floristId } })).toBe(0);
  });

  it("пишет FinanceAudit с причиной и обеими величинами", async () => {
    const [rate] = await consumablesRows();
    const history = await settingHistory("CONSUMABLES_RATE", rate.id);
    const correction = history.find((h) => h.action === "CORRECT_ConsumablesRate");
    expect(correction).toBeDefined();
    expect(correction!.reason).toBe("ошиблись в ставке");
    expect((correction!.beforeJson as { amountCents: number }).amountCents).toBe(500);
    expect((correction!.afterJson as { amountCents: number }).amountCents).toBe(800);
  });

  it("та же сумма пересчитывает день, но денег не двигает", async () => {
    const [rate] = await consumablesRows();
    const before = await floristBalance(floristId);

    const r = await correctSetting({
      entity: "CONSUMABLES_RATE",
      id: rate.id,
      values: { entity: "CONSUMABLES_RATE", amountCents: 800 },
      reason: "повторное подтверждение",
      actor: OWNER,
      now: NOW,
    });

    expect(r.affectedDays).toBe(1);
    expect((await floristBalance(floristId)).outstandingCents).toBe(before.outstandingCents);
  });
});

describe("удаление", () => {
  it("предпросмотр показывает, что заказы выпадут из расчёта", async () => {
    const fee = await prisma.siteAcquiringFeeModel.findFirst({ where: { siteId } });
    const p = await previewSettingChange({ entity: "FEE_MODEL", id: fee!.id, op: "DELETE", now: NOW });

    // Без модели комиссии заказ посчитать нечем — это не «ставка другая», а «настройки нет».
    expect(p.shareBeforeCents).toBeGreaterThan(0);
    expect(p.shareAfterCents).toBe(0);
    expect(p.daysChanged).toBeGreaterThan(0);
    expect(p.warnings.join(" ")).toMatch(/Требует заполнения/);
  });

  it("удаление ставки открывает блокирующую проблему и обнуляет заработок за день", async () => {
    const [rate] = await consumablesRows();
    await deleteSetting({ entity: "CONSUMABLES_RATE", id: rate.id, reason: "заведена по ошибке", actor: OWNER, now: NOW });

    expect(await consumablesRows()).toHaveLength(0);

    const issue = await prisma.financeIssue.findFirst({
      where: { type: "CONSUMABLES_RATE_MISSING", status: "OPEN" },
    });
    expect(issue).not.toBeNull();
    expect(issue!.severity).toBe("BLOCKING");

    // Без ставки расходников заказы недозаполнены, поэтому день перестаёт считаться
    // целиком — правило «всё или ничего».
    const computed = await computeDayShare(profileId, DAY);
    expect(computed!.complete).toBe(false);
    expect(computed!.blockers).toContain("ORDER_DATA_INCOMPLETE");
    expect(computed!.shareCents).toBe(0);

    // Заработок за этот день обнуляется вместе с расчётом — он и есть расчёт.
    expect((await floristBalance(floristId)).earnedCents).toBe(0);
  });

  it("история удалённой записи сохраняется", async () => {
    const audits = await prisma.financeAudit.findMany({
      where: { entity: "ConsumablesRate", action: "DELETE_ConsumablesRate" },
      orderBy: { createdAt: "desc" },
    });
    expect(audits.length).toBeGreaterThan(0);
    expect(audits[0].reason).toBe("заведена по ошибке");
    expect((audits[0].beforeJson as { amountCents: number }).amountCents).toBe(800);
  });

  it("после возврата настройки день считается заново", async () => {
    await fixConsumablesRate({ siteId: null, amountCents: 500, actor: OWNER, now: NOW });

    const computed = await computeDayShare(profileId, DAY);
    expect(computed!.complete).toBe(true);
    expect(computed!.shareCents).toBeGreaterThan(0);
    expect((await floristBalance(floristId)).earnedCents).toBe(computed!.shareCents);
  });
});

describe("налоговая политика", () => {
  it("предпросмотр честно говорит, что на долю флориста она не влияет", async () => {
    const policy = await prisma.ownerTaxPolicy.findFirstOrThrow({ where: { siteId: null } });
    const p = await previewSettingChange({
      entity: "TAX_POLICY",
      id: policy.id,
      op: "CORRECT",
      values: { entity: "TAX_POLICY", actualShareBp: 3000 },
      now: NOW,
    });

    expect(p.shareDeltaCents).toBe(0);
    expect(p.daysChanged).toBe(0);
    expect(p.warnings.join(" ")).toMatch(/на долю флориста не влияет/);
  });

  it("исправление налоговой политики не трогает деньги флориста", async () => {
    const policy = await prisma.ownerTaxPolicy.findFirstOrThrow({ where: { siteId: null } });
    const before = await floristBalance(floristId);

    await correctSetting({
      entity: "TAX_POLICY",
      id: policy.id,
      values: { entity: "TAX_POLICY", actualShareBp: 3000 },
      reason: "уточнили ставку налога",
      actor: OWNER,
      now: NOW,
    });

    expect((await floristBalance(floristId)).outstandingCents).toBe(before.outstandingCents);
    expect(await prisma.ledgerEntry.count({ where: { floristId } })).toBe(0);
  });
});

describe("список записей", () => {
  it("показывает область действия и автора", async () => {
    const rows = await listSettingRecords();
    const globalRate = rows.find((r) => r.entity === "CONSUMABLES_RATE" && r.siteId === null);
    expect(globalRate).toBeDefined();
    expect(globalRate!.siteShortName).toBeNull();
    expect(globalRate!.createdByName).toBe("Owner");

    const fee = rows.find((r) => r.entity === "FEE_MODEL");
    expect(fee!.siteId).toBe(siteId);
    expect(fee!.siteShortName).not.toBeNull();
  });

  it("на каждую область не больше одной записи", async () => {
    const rows = await listSettingRecords();
    const keys = rows.map((r) => `${r.entity}:${r.siteId ?? ""}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
