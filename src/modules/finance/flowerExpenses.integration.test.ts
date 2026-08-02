/**
 * DB integration: раздел ежедневных расходов на цветы.
 *
 * Проверяется то, что нельзя проверить в отрыве от БД: что история не обрезается по
 * давности, что права держатся на резолве профиля, а не на честности вызывающего, и что
 * правка расхода доводится до конца — снимки, детектор и книга.
 *
 * Запуск: DATABASE_URL=<local> npx vitest run --no-file-parallelism \
 *           src/modules/finance/flowerExpenses.integration.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import { prisma } from "@/lib/db";
import { setFinanceProfile } from "./profile";
import { computeDayShare } from "./primaryShare";
import { getFloristBalance } from "./ledger";
import { fixConsumablesRate, fixDeliveryActualCost, fixSiteFeeModel } from "./fix";
import {
  deleteFlowerExpense,
  getFlowerExpenseDay,
  listFlowerExpenses,
  previewFlowerExpense,
  resolveProfileFor,
  saveFlowerExpense,
  FlowerExpenseError,
} from "./flowerExpenses";

const RUN = `fex${crypto.randomBytes(3).toString("hex")}`;
const OWNER = { userId: "", role: "OWNER" as const };
const PRIMARY_ACTOR = { userId: "", role: "FLORIST" as const, floristId: "" };
const SECONDARY_ACTOR = { userId: "", role: "FLORIST" as const, floristId: "" };
const CC_ACTOR = { userId: "", role: "CALL_CENTER" as const };

/** Рабочий день расчёта и день из глубокой истории — заведомо старше 30 суток. */
const DAY = new Date("2026-07-28T00:00:00.000Z");
const OLD_DAY = new Date("2026-01-14T00:00:00.000Z");
const NOW = new Date("2026-07-29T12:00:00.000Z");

let siteId = "";
let productId = "";
let floristId = "";
let profileId = "";
let secondaryFloristId = "";
let secondaryProfileId = "";
let orderA = "";
let orderB = "";
let oldOrder = "";

async function makeOrder(n: string, cents: number, day: Date, florist: string): Promise<string> {
  const o = await prisma.order.create({
    data: {
      orderNumber: `${RUN}-${n}`,
      siteId,
      source: "Website",
      externalCreatedAt: day,
      deliveryDate: day,
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
      currentFloristId: florist,
      items: { create: [{ name: "Bouquet", quantity: 1, externalPrice: (cents / 100).toFixed(2), productId }] },
    },
    select: { id: true },
  });
  return o.id;
}

beforeAll(async () => {
  process.env.FINANCE_PRIMARY_SHARE_START_DATE = "2026-01-01";

  const owner = await prisma.user.create({
    data: { name: "Owner", email: `${RUN}-owner@test.local`, role: "OWNER", passwordHash: "x" },
    select: { id: true },
  });
  OWNER.userId = owner.id;

  const cc = await prisma.user.create({
    data: { name: "CC", email: `${RUN}-cc@test.local`, role: "CALL_CENTER", passwordHash: "x" },
    select: { id: true },
  });
  CC_ACTOR.userId = cc.id;

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

  const primaryUser = await prisma.user.create({
    data: { name: "Nastya", email: `${RUN}-primary@test.local`, role: "FLORIST", passwordHash: "x" },
    select: { id: true },
  });
  const primaryFlorist = await prisma.florist.create({ data: { userId: primaryUser.id }, select: { id: true } });
  floristId = primaryFlorist.id;
  PRIMARY_ACTOR.userId = primaryUser.id;
  PRIMARY_ACTOR.floristId = floristId;

  const secondUser = await prisma.user.create({
    data: { name: "Olga", email: `${RUN}-second@test.local`, role: "FLORIST", passwordHash: "x" },
    select: { id: true },
  });
  const secondFlorist = await prisma.florist.create({ data: { userId: secondUser.id }, select: { id: true } });
  secondaryFloristId = secondFlorist.id;
  SECONDARY_ACTOR.userId = secondUser.id;
  SECONDARY_ACTOR.floristId = secondaryFloristId;

  profileId = (
    await setFinanceProfile({
      floristId,
      model: "PRIMARY",
      sharePercentBp: 6660,
      effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
      actor: OWNER,
    })
  ).createdId;

  secondaryProfileId = (
    await setFinanceProfile({
      floristId: secondaryFloristId,
      model: "SECONDARY",
      effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
      actor: OWNER,
    })
  ).createdId;

  orderA = await makeOrder("A", 10000, DAY, floristId);
  orderB = await makeOrder("B", 20000, DAY, floristId);
  oldOrder = await makeOrder("OLD", 15000, OLD_DAY, floristId);

  await fixConsumablesRate({ siteId: null, amountCents: 500, effectiveFrom: new Date("2026-01-01T00:00:00.000Z"), actor: OWNER, now: NOW });
  await fixSiteFeeModel({ siteId, percentBp: 290, fixedCents: 30, effectiveFrom: new Date("2026-01-01T00:00:00.000Z"), actor: OWNER, now: NOW });
  await fixDeliveryActualCost({ orderId: orderA, amountCents: 1000, actor: OWNER, now: NOW });
  await fixDeliveryActualCost({ orderId: orderB, amountCents: 1000, actor: OWNER, now: NOW });
  await fixDeliveryActualCost({ orderId: oldOrder, amountCents: 1000, actor: OWNER, now: NOW });
});

afterAll(async () => {
  delete process.env.FINANCE_PRIMARY_SHARE_START_DATE;
  await prisma.ledgerEntrySnapshot.deleteMany({ where: { ledgerEntry: { floristId } } });
  await prisma.$executeRawUnsafe(`ALTER TABLE "LedgerEntry" DISABLE TRIGGER USER`);
  await prisma.ledgerEntry.deleteMany({ where: { floristId: { in: [floristId, secondaryFloristId] } } });
  await prisma.$executeRawUnsafe(`ALTER TABLE "LedgerEntry" ENABLE TRIGGER USER`);
  await prisma.$executeRawUnsafe(`ALTER TABLE "OrderFinancialSnapshot" DISABLE TRIGGER USER`);
  await prisma.orderFinancialSnapshot.deleteMany({ where: { order: { siteId } } });
  await prisma.$executeRawUnsafe(`ALTER TABLE "OrderFinancialSnapshot" ENABLE TRIGGER USER`);

  await prisma.financeIssue.deleteMany({ where: { OR: [{ siteId }, { floristId }] } });
  await prisma.financeAudit.deleteMany({ where: { userId: { in: [OWNER.userId, PRIMARY_ACTOR.userId, CC_ACTOR.userId] } } });
  await prisma.dailyFlowerExpense.deleteMany({ where: { financeProfileId: { in: [profileId, secondaryProfileId] } } });
  await prisma.consumablesRate.deleteMany({ where: { siteId: null } });
  await prisma.siteAcquiringFeeModel.deleteMany({ where: { siteId } });
  await prisma.floristFinanceProfile.deleteMany({ where: { floristId: { in: [floristId, secondaryFloristId] } } });
  await prisma.orderItem.deleteMany({ where: { order: { siteId } } });
  await prisma.order.deleteMany({ where: { siteId } });
  await prisma.product.deleteMany({ where: { siteId } });
  await prisma.florist.deleteMany({ where: { id: { in: [floristId, secondaryFloristId] } } });
  await prisma.site.deleteMany({ where: { id: siteId } });
  await prisma.user.deleteMany({ where: { email: { startsWith: RUN } } });
});

describe("права доступа", () => {
  it("владелец работает с действующим PRIMARY-профилем", async () => {
    const p = await resolveProfileFor({ userId: OWNER.userId, role: "OWNER" });
    expect(p?.id).toBe(profileId);
  });

  it("основной флорист получает СВОЙ профиль, а не первый попавшийся", async () => {
    const p = await resolveProfileFor(PRIMARY_ACTOR);
    expect(p?.id).toBe(profileId);
    expect(p?.floristId).toBe(floristId);
  });

  it("второстепенному флористу раздел недоступен", async () => {
    expect(await resolveProfileFor(SECONDARY_ACTOR)).toBeNull();
    await expect(
      saveFlowerExpense({ actor: SECONDARY_ACTOR, expenseDay: DAY, amountCents: 1000, now: NOW })
    ).rejects.toThrow(FlowerExpenseError);
  });

  it("колл-центр не может ни читать профиль, ни писать", async () => {
    expect(await resolveProfileFor(CC_ACTOR)).toBeNull();
    await expect(
      saveFlowerExpense({ actor: CC_ACTOR, expenseDay: DAY, amountCents: 1000, now: NOW })
    ).rejects.toThrow(/владельцу и основному флористу/);
  });

  it("подменить чужой профиль нечем: он резолвится из актора, а не из аргументов", async () => {
    // У флориста нет ни одного параметра, куда можно было бы передать profileId.
    await saveFlowerExpense({ actor: PRIMARY_ACTOR, expenseDay: OLD_DAY, amountCents: 7700, comment: "её запись", now: NOW });
    const rows = await prisma.dailyFlowerExpense.findMany({ where: { expenseDay: OLD_DAY } });
    expect(rows).toHaveLength(1);
    expect(rows[0].financeProfileId).toBe(profileId);
    expect(rows[0].createdBy).toBe(PRIMARY_ACTOR.userId);
    // У второстепенного профиля не появилось ничего.
    expect(await prisma.dailyFlowerExpense.count({ where: { financeProfileId: secondaryProfileId } })).toBe(0);
  });
});

describe("история за всё время", () => {
  it("запись старше 30 дней видна и никуда не делась", async () => {
    const all = await listFlowerExpenses(profileId, floristId, { from: null, to: null }, { page: 1, perPage: 500 });
    const old = all.rows.find((r) => r.day === "2026-01-14");
    expect(old?.expense?.amountCents).toBe(7700);
  });

  it("дни без внесённого расхода показываются, иначе пропуск не найти", async () => {
    const all = await listFlowerExpenses(profileId, floristId, { from: null, to: null }, { page: 1, perPage: 500 });
    const workDay = all.rows.find((r) => r.day === "2026-07-28");
    expect(workDay).toBeDefined();
    expect(workDay!.expense).toBeNull();
    expect(workDay!.status).toBe("MISSING");
    expect(workDay!.ordersTotal).toBe(2);
  });

  it("фильтр по месяцу отбирает только свой месяц", async () => {
    const jan = await listFlowerExpenses(
      profileId,
      floristId,
      { from: new Date("2026-01-01T00:00:00.000Z"), to: new Date("2026-01-31T00:00:00.000Z") },
      { page: 1, perPage: 100 }
    );
    expect(jan.rows.map((r) => r.day)).toEqual(["2026-01-14"]);

    const july = await listFlowerExpenses(
      profileId,
      floristId,
      { from: new Date("2026-07-01T00:00:00.000Z"), to: new Date("2026-07-31T00:00:00.000Z") },
      { page: 1, perPage: 100 }
    );
    expect(july.rows.map((r) => r.day)).toEqual(["2026-07-28"]);
  });

  it("поиск по комментарию находит запись независимо от регистра", async () => {
    const found = await listFlowerExpenses(profileId, floristId, { from: null, to: null, query: "ЕЁ ЗАП" }, { page: 1, perPage: 50 });
    expect(found.rows.map((r) => r.day)).toEqual(["2026-01-14"]);
  });

  it("фильтр по статусу оставляет только запрошенный", async () => {
    const missing = await listFlowerExpenses(profileId, floristId, { from: null, to: null, status: "MISSING" }, { page: 1, perPage: 50 });
    expect(missing.rows.every((r) => r.expense == null)).toBe(true);
    expect(missing.rows.map((r) => r.day)).toContain("2026-07-28");
  });

  it("пагинация не теряет старые записи: они на следующей странице, а не за бортом", async () => {
    const first = await listFlowerExpenses(profileId, floristId, { from: null, to: null }, { page: 1, perPage: 1 });
    const second = await listFlowerExpenses(profileId, floristId, { from: null, to: null }, { page: 2, perPage: 1 });
    expect(first.totalDays).toBe(2);
    expect(second.totalDays).toBe(2);
    expect(first.rows[0].day).toBe("2026-07-28");
    expect(second.rows[0].day).toBe("2026-01-14");
    // Итоги считаются по всему периоду, а не по видимой странице.
    expect(first.totals.expenseCents).toBe(7700);
    expect(second.totals.expenseCents).toBe(7700);
  });
});

describe("правка расхода доводится до конца", () => {
  it("внесение закупки публикует снимки и создаёт начисление", async () => {
    const r = await saveFlowerExpense({ actor: OWNER, expenseDay: DAY, amountCents: 6000, comment: "первая закупка", now: NOW });
    expect(r.republished).toBeGreaterThan(0);
    expect(r.share.status).toBe("CREATED");

    const computed = await computeDayShare(profileId, DAY);
    expect(computed!.blocked).toBe(false);
    // Сверяем именно этот день: у флориста уже есть начисление за январь из проверки прав.
    const entries = await prisma.ledgerEntry.findMany({
      where: { floristId, type: "PRIMARY_FLORIST_SHARE", effectiveDate: DAY, reversal: null },
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].amountCents).toBe(computed!.shareCents);
  });

  it("день с расходом, но без посчитанных заказов, не пугает «требует проверки»", async () => {
    // Закупка была, доставленных заказов в этот день нет — считать нечего, и статус
    // должен говорить «заполнено», а не требовать разбираться с несуществующей проблемой.
    const quiet = new Date("2026-03-05T00:00:00.000Z");
    await saveFlowerExpense({ actor: OWNER, expenseDay: quiet, amountCents: 4200, comment: "день без доставок", now: NOW });

    const list = await listFlowerExpenses(profileId, floristId, { from: quiet, to: quiet }, { page: 1, perPage: 5 });
    expect(list.rows[0].ordersTotal).toBe(0);
    expect(list.rows[0].hasPublishedSnapshot).toBe(false);
    expect(list.rows[0].status).toBe("FILLED");
  });

  it("день становится «использован в расчёте»", async () => {
    const list = await listFlowerExpenses(profileId, floristId, { from: DAY, to: DAY }, { page: 1, perPage: 10 });
    expect(list.rows[0].status).toBe("USED");
    expect(list.rows[0].accruedCents).toBeGreaterThan(0);
    expect(list.rows[0].hasPublishedSnapshot).toBe(true);
  });

  it("предпросмотр показывает будущую разницу, ничего не записывая", async () => {
    const before = await prisma.ledgerEntry.count({ where: { floristId } });
    const p = await previewFlowerExpense(profileId, DAY, 9000);

    expect(p.fromCents).toBe(6000);
    expect(p.toCents).toBe(9000);
    expect(p.expenseDeltaCents).toBe(3000);
    expect(p.alreadyUsed).toBe(true);
    // Расход вырос — распределяемая прибыль и доля упали.
    expect(p.shareDeltaCents).toBeLessThan(0);
    expect(p.ordersAffected).toBe(2);
    expect(await prisma.ledgerEntry.count({ where: { floristId } })).toBe(before);
  });

  it("изменение суммы пересобирает снимки и правит книгу через сторно", async () => {
    const revisionsBefore = await prisma.orderFinancialSnapshot.count({ where: { order: { siteId } } });
    const balanceBefore = await getFloristBalance(floristId);

    const r = await saveFlowerExpense({ actor: OWNER, expenseDay: DAY, amountCents: 9000, comment: "уточнил чек", now: NOW });
    expect(r.share.status).toBe("CORRECTED");
    expect(r.share.toCents).toBeLessThan(r.share.fromCents!);

    expect(await prisma.orderFinancialSnapshot.count({ where: { order: { siteId } } })).toBeGreaterThan(revisionsBefore);
    // Прежняя запись не отредактирована, а сторнирована отдельной строкой.
    const reversal = await prisma.ledgerEntry.findFirst({ where: { floristId, type: "CORRECTION", reversedEntryId: { not: null } } });
    expect(reversal).not.toBeNull();

    // Баланс изменился ровно на разницу доли за этот день и ни на цент больше:
    // начисления других дней правка не задевает.
    const balanceAfter = await getFloristBalance(floristId);
    expect(balanceBefore.outstandingCents - balanceAfter.outstandingCents).toBe(r.share.fromCents! - r.share.toCents!);

    const live = await prisma.ledgerEntry.findMany({
      where: { floristId, type: "PRIMARY_FLORIST_SHARE", effectiveDate: DAY, reversal: null },
    });
    expect(live).toHaveLength(1);
    expect(live[0].amountCents).toBe((await computeDayShare(profileId, DAY))!.shareCents);
  });

  it("та же сумма не создаёт ни одной новой записи в книге", async () => {
    const before = await prisma.ledgerEntry.count({ where: { floristId } });
    const r = await saveFlowerExpense({ actor: OWNER, expenseDay: DAY, amountCents: 9000, comment: "тот же чек", now: NOW });
    expect(r.share.status).toBe("UNCHANGED");
    expect(await prisma.ledgerEntry.count({ where: { floristId } })).toBe(before);
  });

  it("правка комментария не трогает ни ревизии, ни книгу", async () => {
    const snapsBefore = await prisma.orderFinancialSnapshot.count({ where: { order: { siteId } } });
    const ledgerBefore = await prisma.ledgerEntry.count({ where: { floristId } });

    const r = await saveFlowerExpense({ actor: OWNER, expenseDay: DAY, amountCents: 9000, comment: "переформулировал", now: NOW });
    expect(r.republished).toBe(0);
    expect(r.share.status).toBe("UNCHANGED");
    expect(await prisma.orderFinancialSnapshot.count({ where: { order: { siteId } } })).toBe(snapsBefore);
    expect(await prisma.ledgerEntry.count({ where: { floristId } })).toBe(ledgerBefore);
  });

  it("каждая правка попадает в историю изменений с автором и ролью", async () => {
    const { history } = await getFlowerExpenseDay(profileId, floristId, DAY);
    expect(history.length).toBeGreaterThanOrEqual(2);
    expect(history[0].action).toBe("UPDATE_DAILY_FLOWER_EXPENSE");
    expect(history.some((h) => h.action === "SET_DAILY_FLOWER_EXPENSE")).toBe(true);
    expect(history.every((h) => h.role === "OWNER")).toBe(true);
  });

  it("правка сохраняет автора создания и записывает редактора", async () => {
    const row = await prisma.dailyFlowerExpense.findUnique({
      where: { financeProfileId_expenseDay: { financeProfileId: profileId, expenseDay: DAY } },
    });
    expect(row!.createdBy).toBe(OWNER.userId);
    expect(row!.updatedBy).toBe(OWNER.userId);
    expect(row!.updatedAt.getTime()).toBeGreaterThanOrEqual(row!.createdAt.getTime());
  });
});

describe("удаление", () => {
  it("требует причину", async () => {
    await expect(deleteFlowerExpense({ actor: OWNER, expenseDay: DAY, reason: "   ", now: NOW })).rejects.toThrow(
      /причину/
    );
  });

  it("сторнирует начисление и открывает блокирующую проблему", async () => {
    const accrued = (await computeDayShare(profileId, DAY))!.shareCents;
    const balanceBefore = await getFloristBalance(floristId);

    const r = await deleteFlowerExpense({ actor: OWNER, expenseDay: DAY, reason: "внесено не в тот день", now: NOW });
    expect(r.reversedCents).toBe(accrued);

    // В книге не осталось действующего начисления за день.
    const live = await prisma.ledgerEntry.findMany({
      where: { floristId, type: "PRIMARY_FLORIST_SHARE", effectiveDate: DAY, reversal: null },
    });
    expect(live).toHaveLength(0);
    // Из баланса ушла ровно сторнированная сумма; январское начисление осталось на месте.
    const balanceAfter = await getFloristBalance(floristId);
    expect(balanceBefore.outstandingCents - balanceAfter.outstandingCents).toBe(accrued);

    // День снова требует заполнения.
    const issue = await prisma.financeIssue.findFirst({
      where: { type: "DAILY_FLOWER_EXPENSE_MISSING", scopeDate: DAY, status: "OPEN" },
    });
    expect(issue).not.toBeNull();
    expect(issue!.severity).toBe("BLOCKING");
  });

  it("история удалённой записи сохраняется", async () => {
    const { row, history } = await getFlowerExpenseDay(profileId, floristId, DAY);
    expect(row.expense).toBeNull();
    expect(row.status).toBe("MISSING");
    expect(history.some((h) => h.action === "DELETE_DAILY_FLOWER_EXPENSE")).toBe(true);
    expect(history.find((h) => h.action === "DELETE_DAILY_FLOWER_EXPENSE")!.reason).toBe("внесено не в тот день");
  });

  it("удалять нечего — понятная ошибка, а не молчание", async () => {
    await expect(deleteFlowerExpense({ actor: OWNER, expenseDay: DAY, reason: "ещё раз", now: NOW })).rejects.toThrow(
      /не внесён/
    );
  });
});
