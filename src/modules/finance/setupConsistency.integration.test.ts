/**
 * Согласованность двух экранов. Требует живой БД в DATABASE_URL.
 *
 * История: обзор флористов считает недостающие данные на лету и говорил «5 дней не посчитано»,
 * а очередь «Требует заполнения» отвечала «всё заполнено» — потому что она показывала таблицу,
 * которую наполняет детектор, а он запускался только вручную. Оба экрана были по-своему правы,
 * и это худший вид расхождения: спорить не с чем, а верить нечему.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { prisma } from "@/lib/db";
import { detectFinanceIssues, getIssueSummary } from "./issues";

const RUN = `setupc-${Date.now()}`;
const DAY = new Date("2026-08-12T00:00:00.000Z");
let siteId = "";
let floristId = "";
let ownerId = "";

beforeAll(async () => {
  // Гейты расчёта задаём сами: без них детектор молчит по построению, и тест проверял бы
  // тишину вместо поведения. Соседние финансовые тесты делают так же.
  process.env.FINANCE_ACCRUAL_ENABLED = "true";
  process.env.FINANCE_ACCRUAL_START_DATE = "2026-08-01";
  process.env.FINANCE_PRIMARY_SHARE_START_DATE = "2026-08-01";

  const site = await prisma.site.create({
    data: { name: `${RUN}-site`, shortName: "STC", platform: "SHOPIFY", connectionStatus: "CONNECTED" },
  });
  siteId = site.id;

  const owner = await prisma.user.create({
    data: { name: "Владелец", email: `${RUN}-owner@example.com`, role: "OWNER", passwordHash: "x" },
  });
  ownerId = owner.id;

  const user = await prisma.user.create({
    data: { name: "Основной", email: `${RUN}-f@example.com`, role: "FLORIST", passwordHash: "x" },
  });
  const florist = await prisma.florist.create({ data: { userId: user.id, financeVisibility: "FULL" } });
  floristId = florist.id;

  await prisma.floristFinanceProfile.create({
    data: {
      floristId,
      model: "PRIMARY",
      sharePercentBp: 6660,
      effectiveFrom: new Date("2026-08-01T00:00:00.000Z"),
      active: true,
      createdBy: ownerId,
    },
  });
});

beforeEach(async () => {
  await prisma.financeIssue.deleteMany({ where: { siteId } });
  await prisma.order.deleteMany({ where: { siteId } });
});

afterAll(async () => {
  delete process.env.FINANCE_ACCRUAL_ENABLED;
  delete process.env.FINANCE_ACCRUAL_START_DATE;
  delete process.env.FINANCE_PRIMARY_SHARE_START_DATE;

  await prisma.financeIssue.deleteMany({ where: { siteId } }).catch(() => {});
  await prisma.order.deleteMany({ where: { siteId } }).catch(() => {});
  await prisma.floristFinanceProfile.deleteMany({ where: { floristId } }).catch(() => {});
  await prisma.florist.delete({ where: { id: floristId } }).catch(() => {});
  await prisma.user.deleteMany({ where: { email: { startsWith: RUN } } }).catch(() => {});
  await prisma.site.delete({ where: { id: siteId } }).catch(() => {});
});

async function makeDeliveredOrder(num: string) {
  return prisma.order.create({
    data: {
      orderNumber: num,
      siteId,
      platform: "SHOPIFY",
      source: "MANUAL",
      externalCreatedAt: new Date("2026-08-11T10:00:00Z"),
      deliveryDate: DAY,
      deliveryWindow: "12:00 – 16:00",
      senderName: "Заказчик",
      senderPhone: "+14245550000",
      recipientName: "Получатель",
      recipientPhone: "+14245551111",
      addressLine: "1 Main St",
      city: "LA",
      zip: "90001",
      itemsTotal: "100.00",
      customerTotal: "120.00",
      orderStatus: "DELIVERED",
      paymentStatus: "PAID",
      currentFloristId: floristId,
    },
  });
}

describe("очередь «Требует заполнения»", () => {
  it("прогон детектора находит незаполненное — очередь перестаёт врать про «всё заполнено»", async () => {
    await makeDeliveredOrder(`${RUN}-1`);

    const before = await getIssueSummary();
    await detectFinanceIssues();
    const after = await getIssueSummary();

    expect(after.blocking + after.warning).toBeGreaterThan(before.blocking + before.warning);
  });

  it("повторный прогон ничего не плодит — открывать страницу можно сколько угодно", async () => {
    // Прогон идёт при каждом открытии страницы, поэтому неидемпотентность означала бы растущую
    // мусорную очередь.
    await makeDeliveredOrder(`${RUN}-2`);

    await detectFinanceIssues();
    const first = await prisma.financeIssue.count({ where: { siteId } });
    await detectFinanceIssues();
    const second = await prisma.financeIssue.count({ where: { siteId } });

    expect(second).toBe(first);
  });

  it("когда данных не хватает, очередь непуста", async () => {
    await makeDeliveredOrder(`${RUN}-3`);
    await detectFinanceIssues();
    expect(await prisma.financeIssue.count({ where: { siteId, status: "OPEN" } })).toBeGreaterThan(0);
  });
});
