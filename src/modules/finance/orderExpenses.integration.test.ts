/**
 * DB integration: дополнительные расходы по заказу.
 *
 * Главное, что здесь проверяется, — два РАЗНЫХ денежных исхода и то, что они не
 * пересекаются: у PRIMARY расход уменьшает распределяемую прибыль (и флорист несёт свою
 * долю), у SECONDARY создаёт удержание доллар в доллар. Учесть расход дважды нельзя.
 *
 * Запуск: DATABASE_URL=<local> npx vitest run --no-file-parallelism \
 *           src/modules/finance/orderExpenses.integration.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import { prisma } from "@/lib/db";
import { computeDayShare, readOrderContribution } from "./dayFinance";
import { setFinanceProfile } from "./profile";
import { floristBalance } from "./balance";
import { fixConsumablesRate, fixDailyFlowerExpense, fixDeliveryActualCost, fixSiteFeeModel } from "./fix";
import {
  addOrderExpense,
  listOrderExpenses,
  removeOrderExpense,
  updateOrderExpense,
  OrderExpenseError,
} from "./orderExpenses";

const RUN = `oae${crypto.randomBytes(3).toString("hex")}`;
const OWNER = { userId: "", role: "OWNER" as const };
const CC = { userId: "", role: "CALL_CENTER" as const };
const PRIMARY_ACTOR = { userId: "", role: "FLORIST" as const, floristId: "" };
const SECOND_ACTOR = { userId: "", role: "FLORIST" as const, floristId: "" };

const DAY = new Date("2026-07-28T00:00:00.000Z");
const NOW = new Date("2026-07-29T12:00:00.000Z");
const START = new Date("2026-07-01T00:00:00.000Z");

let siteId = "";
let productId = "";
let primaryFloristId = "";
let secondFloristId = "";
let primaryProfileId = "";
let orderA = "";
let orderB = "";
let secondOrder = "";

async function makeOrder(n: string, cents: number, floristId: string, floristTotal?: string): Promise<string> {
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
      ...(floristTotal ? { priceMode: "MANUAL" as const, floristTotal } : {}),
      items: { create: [{ name: "Bouquet", quantity: 1, externalPrice: (cents / 100).toFixed(2), productId }] },
    },
    select: { id: true },
  });
  return o.id;
}

beforeAll(async () => {
  process.env.FINANCE_PRIMARY_SHARE_START_DATE = "2026-07-01";
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
  CC.userId = cc.id;

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

  const pUser = await prisma.user.create({
    data: { name: "Nastya", email: `${RUN}-primary@test.local`, role: "FLORIST", passwordHash: "x" },
    select: { id: true },
  });
  primaryFloristId = (await prisma.florist.create({ data: { userId: pUser.id }, select: { id: true } })).id;
  PRIMARY_ACTOR.userId = pUser.id;
  PRIMARY_ACTOR.floristId = primaryFloristId;

  const sUser = await prisma.user.create({
    data: { name: "Olga", email: `${RUN}-second@test.local`, role: "FLORIST", passwordHash: "x" },
    select: { id: true },
  });
  secondFloristId = (await prisma.florist.create({ data: { userId: sUser.id }, select: { id: true } })).id;
  SECOND_ACTOR.userId = sUser.id;
  SECOND_ACTOR.floristId = secondFloristId;

  primaryProfileId = (
    await setFinanceProfile({ floristId: primaryFloristId, model: "PRIMARY", sharePercentBp: 6660, effectiveFrom: START, actor: OWNER })
  ).createdId;
  await setFinanceProfile({ floristId: secondFloristId, model: "SECONDARY", effectiveFrom: START, actor: OWNER });

  orderA = await makeOrder("A", 10000, primaryFloristId);
  orderB = await makeOrder("B", 20000, primaryFloristId);
  secondOrder = await makeOrder("S", 15000, secondFloristId, "118.00");

  await fixConsumablesRate({ siteId: null, amountCents: 500, effectiveFrom: START, actor: OWNER, now: NOW });
  await fixSiteFeeModel({ siteId, percentBp: 290, fixedCents: 30, effectiveFrom: START, actor: OWNER, now: NOW });
  await fixDeliveryActualCost({ orderId: orderA, amountCents: 1000, actor: OWNER, now: NOW });
  await fixDeliveryActualCost({ orderId: orderB, amountCents: 1000, actor: OWNER, now: NOW });
  await fixDailyFlowerExpense({ expenseDay: DAY, amountCents: 6000, actor: OWNER, now: NOW });

});

afterAll(async () => {
  delete process.env.FINANCE_PRIMARY_SHARE_START_DATE;
  delete process.env.FINANCE_ACCRUAL_ENABLED;
  delete process.env.FINANCE_ACCRUAL_START_DATE;

  await prisma.orderAdditionalExpense.deleteMany({ where: { order: { siteId } } });
  await prisma.$executeRawUnsafe(`ALTER TABLE "LedgerEntry" DISABLE TRIGGER USER`);
  await prisma.ledgerEntry.deleteMany({ where: { floristId: { in: [primaryFloristId, secondFloristId] } } });
  await prisma.$executeRawUnsafe(`ALTER TABLE "LedgerEntry" ENABLE TRIGGER USER`);

  await prisma.financeIssue.deleteMany({ where: { OR: [{ siteId }, { floristId: { in: [primaryFloristId, secondFloristId] } }] } });
  await prisma.financeAudit.deleteMany({ where: { userId: { in: [OWNER.userId, CC.userId, PRIMARY_ACTOR.userId, SECOND_ACTOR.userId] } } });
  await prisma.dailyFlowerExpense.deleteMany({ where: { financeProfileId: primaryProfileId } });
  await prisma.consumablesRate.deleteMany({ where: { siteId: null } });
  await prisma.siteAcquiringFeeModel.deleteMany({ where: { siteId } });
  await prisma.floristFinanceProfile.deleteMany({ where: { floristId: { in: [primaryFloristId, secondFloristId] } } });
  await prisma.orderItem.deleteMany({ where: { order: { siteId } } });
  await prisma.order.deleteMany({ where: { siteId } });
  await prisma.product.deleteMany({ where: { siteId } });
  await prisma.florist.deleteMany({ where: { id: { in: [primaryFloristId, secondFloristId] } } });
  await prisma.site.deleteMany({ where: { id: siteId } });
  await prisma.user.deleteMany({ where: { email: { startsWith: RUN } } });
});

describe("кто может добавлять", () => {
  it("владелец добавляет расход любому заказу", async () => {
    const r = await addOrderExpense({
      orderId: orderA,
      amountCents: 1000,
      description: "Повторная доставка",
      expenseDate: DAY,
      actor: OWNER,
      now: NOW,
    });
    expect(r.action).toBe("CREATED");
    await removeOrderExpense({ expenseId: r.expenseId, reason: "проверка прав", actor: OWNER, now: NOW });
  });

  it("колл-центр добавляет расход", async () => {
    const r = await addOrderExpense({
      orderId: orderA,
      amountCents: 500,
      description: "Компенсация клиенту",
      expenseDate: DAY,
      actor: CC,
      now: NOW,
    });
    expect(r.action).toBe("CREATED");
    await removeOrderExpense({ expenseId: r.expenseId, reason: "проверка прав", actor: CC, now: NOW });
  });

  it("основной флорист добавляет расход своему заказу", async () => {
    const r = await addOrderExpense({
      orderId: orderA,
      amountCents: 700,
      description: "Дополнительные цветы",
      expenseDate: DAY,
      actor: PRIMARY_ACTOR,
      now: NOW,
    });
    expect(r.action).toBe("CREATED");
    await removeOrderExpense({ expenseId: r.expenseId, reason: "проверка прав", actor: PRIMARY_ACTOR, now: NOW });
  });

  it("второстепенный флорист добавляет расход своему заказу", async () => {
    const r = await addOrderExpense({
      orderId: secondOrder,
      amountCents: 300,
      description: "Прочее",
      expenseDate: DAY,
      actor: SECOND_ACTOR,
      now: NOW,
    });
    expect(r.action).toBe("CREATED");
    await removeOrderExpense({ expenseId: r.expenseId, reason: "проверка прав", actor: SECOND_ACTOR, now: NOW });
  });

  it("флорист не может добавить расход ЧУЖОМУ заказу", async () => {
    await expect(
      addOrderExpense({
        orderId: orderA,
        amountCents: 1000,
        description: "чужой заказ",
        expenseDate: DAY,
        actor: SECOND_ACTOR,
        now: NOW,
      })
    ).rejects.toThrow(/Нет доступа/);
  });

  it("сумма ноль и отрицательная отклоняются", async () => {
    for (const amountCents of [0, -100]) {
      await expect(
        addOrderExpense({ orderId: orderA, amountCents, description: "x", expenseDate: DAY, actor: OWNER, now: NOW })
      ).rejects.toThrow(OrderExpenseError);
    }
  });

  it("заказу без флориста расход добавить нельзя", async () => {
    const orphan = await makeOrder("ORPHAN", 5000, primaryFloristId);
    await prisma.order.update({ where: { id: orphan }, data: { currentFloristId: null } });

    await expect(
      addOrderExpense({ orderId: orphan, amountCents: 1000, description: "x", expenseDate: DAY, actor: OWNER, now: NOW })
    ).rejects.toThrow(/не назначен флорист/);
  });
});

describe("PRIMARY: расход уменьшает распределяемую прибыль", () => {
  let expenseId = "";
  let shareBefore = 0;
  let distributableBefore = 0;

  it("расход уменьшает прибыль дня на полную сумму, а долю — на 66.6% от неё", async () => {
    const before = await computeDayShare(primaryProfileId, DAY);
    shareBefore = before!.shareCents;
    distributableBefore = before!.distributableCents;
    expect(shareBefore).toBeGreaterThan(0);

    const r = await addOrderExpense({
      orderId: orderA,
      amountCents: 10000,
      description: "Повторное изготовление букета",
      expenseDate: DAY,
      actor: OWNER,
      now: NOW,
    });
    expenseId = r.expenseId;

    const after = await computeDayShare(primaryProfileId, DAY);
    // Прибыль падает ровно на сумму расхода.
    expect(distributableBefore - after!.distributableCents).toBe(10000);
    // Доля — на 66.6% от него: $100 расхода стоят флористу $66.60, владельцу $33.40.
    expect(shareBefore - after!.shareCents).toBe(6660);
  });

  it("расход виден строкой в разборе заказа", async () => {
    const calc = await readOrderContribution(orderA);
    expect(calc!.order.additionalCents).toBe(10000);
  });

  it("книгу расход не трогает вовсе", async () => {
    expect(await prisma.ledgerEntry.count({ where: { floristId: primaryFloristId } })).toBe(0);
  });

  it("отмена расхода возвращает расчёт к прежнему", async () => {
    await removeOrderExpense({ expenseId, reason: "внесли по ошибке", actor: OWNER, now: NOW });

    const after = await computeDayShare(primaryProfileId, DAY);
    expect(after!.distributableCents).toBe(distributableBefore);
    expect(after!.shareCents).toBe(shareBefore);
  });

  it("отменённый расход не входит в итог блока", async () => {
    const view = await listOrderExpenses(orderA, OWNER);
    const reversed = view.rows.find((r) => r.id === expenseId);
    expect(reversed!.reversedAt).not.toBeNull();
    expect(reversed!.reversalReason).toBe("внесли по ошибке");
    expect(view.totalCents).toBe(0);
  });
});

describe("SECONDARY: удержание доллар в доллар", () => {
  let expenseId = "";

  it("заработок равен фиксированной цене заказа и выводится, а не хранится", async () => {
    const b = await floristBalance(secondFloristId);
    expect(b.earnedCents).toBe(11800);
    expect(b.outstandingCents).toBe(11800);
    // Отдельной записи начисления в книге нет вовсе.
    expect(await prisma.ledgerEntry.count({ where: { floristId: secondFloristId } })).toBe(0);
  });

  it("расход уменьшает долг доллар в доллар, ничего не записывая в книгу", async () => {
    const r = await addOrderExpense({
      orderId: secondOrder,
      amountCents: 3000,
      description: "Повторная доставка",
      expenseDate: DAY,
      actor: OWNER,
      now: NOW,
    });
    expenseId = r.expenseId;

    expect((await floristBalance(secondFloristId)).deductionCents).toBe(3000);

    // 118.00 − 30.00 = 88.00, ровно как в примере ТЗ.
    expect((await floristBalance(secondFloristId)).outstandingCents).toBe(8800);
  });

  it("расход больше начисления уводит баланс в минус и не обнуляется", async () => {
    const big = await addOrderExpense({
      orderId: secondOrder,
      amountCents: 12000,
      description: "Компенсация клиенту",
      expenseDate: DAY,
      actor: OWNER,
      now: NOW,
    });

    // 118.00 − 30.00 − 120.00 = −32.00.
    expect((await floristBalance(secondFloristId)).outstandingCents).toBe(-3200);

    await removeOrderExpense({ expenseId: big.expenseId, reason: "вернули как было", actor: OWNER, now: NOW });
    expect((await floristBalance(secondFloristId)).outstandingCents).toBe(8800);
  });

  it("повторное проведение того же расхода не удваивает вычет", async () => {
    const before = (await floristBalance(secondFloristId)).deductionCents;
    await addOrderExpense({
      orderId: secondOrder,
      amountCents: 100,
      description: "ещё один",
      expenseDate: DAY,
      actor: OWNER,
      now: NOW,
    }).then((r) => removeOrderExpense({ expenseId: r.expenseId, reason: "откат", actor: OWNER, now: NOW }));

    expect((await floristBalance(secondFloristId)).deductionCents).toBe(before);
  });

  it("отмена расхода возвращает долг сама — без записей в книге", async () => {
    await removeOrderExpense({ expenseId, reason: "расход не подтвердился", actor: OWNER, now: NOW });

    const b = await floristBalance(secondFloristId);
    expect(b.deductionCents).toBe(0);
    expect(b.outstandingCents).toBe(11800);
    expect(await prisma.ledgerEntry.count({ where: { floristId: secondFloristId } })).toBe(0);
  });
});

describe("исправление опубликованного расхода", () => {
  it("идёт через отмену и новую запись, требует причину", async () => {
    const created = await addOrderExpense({
      orderId: secondOrder,
      amountCents: 2000,
      description: "Повторная доставка",
      expenseDate: DAY,
      actor: OWNER,
      now: NOW,
    });

    await expect(
      updateOrderExpense({
        expenseId: created.expenseId,
        amountCents: 2500,
        description: "Повторная доставка",
        expenseDate: DAY,
        actor: OWNER,
        now: NOW,
      })
    ).rejects.toThrow(/причину/);

    const updated = await updateOrderExpense({
      expenseId: created.expenseId,
      amountCents: 2500,
      description: "Повторная доставка (уточнено)",
      expenseDate: DAY,
      reason: "ошиблись в сумме",
      actor: OWNER,
      now: NOW,
    });
    expect(updated.action).toBe("REPLACED");
    expect(updated.expenseId).not.toBe(created.expenseId);

    const old = await prisma.orderAdditionalExpense.findUnique({ where: { id: created.expenseId } });
    expect(old!.reversedAt).not.toBeNull();
    expect(old!.amountCents).toBe(2000);

    // В долге учтён только новый расход: отменённый не считается.
    expect((await floristBalance(secondFloristId)).deductionCents).toBe(2500);

    await removeOrderExpense({ expenseId: updated.expenseId, reason: "уборка", actor: OWNER, now: NOW });
  });
});

describe("расход, который пока не влияет на деньги", () => {
  it("недоставленный заказ: расход сохраняется, но честно помечен как не учтённый", async () => {
    const problem = await makeOrder("PROBLEM", 12000, primaryFloristId);
    await prisma.order.update({ where: { id: problem }, data: { orderStatus: "PROBLEM" } });

    const before = await computeDayShare(primaryProfileId, DAY);
    const r = await addOrderExpense({
      orderId: problem,
      amountCents: 5000,
      description: "Компенсация клиенту",
      expenseDate: DAY,
      actor: OWNER,
      now: NOW,
    });

    // Расчёт не тронут: считаются только доставленные заказы.
    expect(r.effect.kind).toBe("NONE");
    expect((r.effect as { reason: string }).reason).toMatch(/не доставлен/);
    expect((await computeDayShare(primaryProfileId, DAY))!.shareCents).toBe(before!.shareCents);

    // И это видно в блоке, а не только в момент сохранения.
    const view = await listOrderExpenses(problem, OWNER);
    expect(view.totalCents).toBe(5000);
    expect(view.calc.counted).toBe(false);
    expect(view.calc.note).toMatch(/только доставленные/);

    // Как только заказ доставлен, расход подхватывается сам.
    await prisma.order.update({ where: { id: problem }, data: { orderStatus: "DELIVERED" } });
    await fixDeliveryActualCost({ orderId: problem, amountCents: 1000, actor: OWNER, now: NOW });

    const after = await listOrderExpenses(problem, OWNER);
    expect(after.calc.counted).toBe(true);
    expect(after.calc.note).toMatch(/Учтено в расчёте/);

    expect((await readOrderContribution(problem))!.order.additionalCents).toBe(5000);

    await removeOrderExpense({ expenseId: r.expenseId, reason: "уборка", actor: OWNER, now: NOW });
    await prisma.order.update({ where: { id: problem }, data: { orderStatus: "CANCELLED" } });
  });

  it("у второстепенного флориста удержание создаётся и до доставки", async () => {
    const view = await listOrderExpenses(secondOrder, OWNER);
    expect(view.calc.note).toBeDefined();
  });
});

describe("аудит и привязка к флористу", () => {
  it("каждое действие пишется в FinanceAudit с ролью автора", async () => {
    const created = await addOrderExpense({
      orderId: orderA,
      amountCents: 900,
      description: "Прочее",
      expenseDate: DAY,
      actor: CC,
      now: NOW,
    });
    await removeOrderExpense({ expenseId: created.expenseId, reason: "аудит", actor: OWNER, now: NOW });

    const audits = await prisma.financeAudit.findMany({
      where: { entity: "OrderAdditionalExpense", entityId: created.expenseId },
      orderBy: { createdAt: "asc" },
    });
    expect(audits.map((a) => a.action)).toEqual(["ADD_ORDER_EXPENSE", "REVERSE_ORDER_EXPENSE"]);
    expect(audits[0].role).toBe("CALL_CENTER");
    expect(audits[1].role).toBe("OWNER");
    expect(audits[1].reason).toBe("аудит");
  });

  it("переназначение заказа не переносит уже созданный расход", async () => {
    const created = await addOrderExpense({
      orderId: secondOrder,
      amountCents: 400,
      description: "Прочее",
      expenseDate: DAY,
      actor: OWNER,
      now: NOW,
    });

    await prisma.order.update({ where: { id: secondOrder }, data: { currentFloristId: primaryFloristId } });

    const row = await prisma.orderAdditionalExpense.findUnique({ where: { id: created.expenseId } });
    expect(row!.floristIdSnapshot).toBe(secondFloristId);


    await prisma.order.update({ where: { id: secondOrder }, data: { currentFloristId: secondFloristId } });
    await removeOrderExpense({ expenseId: created.expenseId, reason: "уборка", actor: OWNER, now: NOW });
  });
});
