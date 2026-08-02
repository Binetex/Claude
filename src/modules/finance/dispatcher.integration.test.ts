/**
 * DB integration: диспетчер начислений.
 *
 * Главный сценарий — голодание. На проде 115 заказов основного флориста заняли весь лимит
 * первого тика: записи в книге у них не появляется никогда (доля за период — следующий этап),
 * поэтому они оставались кандидатами вечно, и 12 заказов второстепенного флориста не были
 * поставлены в очередь НИ РАЗУ. Тест фиксирует, что второй тик доводит дело до конца.
 *
 * Запуск: DATABASE_URL=<local> npx vitest run --no-file-parallelism \
 *           src/modules/finance/dispatcher.integration.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import { prisma } from "@/lib/db";
import { dispatchFinanceAccruals, DISPATCH_LIMIT } from "./dispatcher";
import { financeAccrualKey } from "./events";
import { setFinanceProfile } from "./profile";

const RUN = `dsp${crypto.randomBytes(3).toString("hex")}`;
const OWNER = { userId: "", role: "OWNER" as const };
const JULY = new Date("2026-07-10T00:00:00.000Z");

let siteId = "";
let primaryId = "";
let secondaryId = "";
const secondaryOrderIds: string[] = [];

async function makeFlorist(name: string): Promise<string> {
  const user = await prisma.user.create({
    data: { name, email: `${RUN}-${name}@test.local`, role: "FLORIST", passwordHash: "x" },
    select: { id: true },
  });
  const f = await prisma.florist.create({ data: { userId: user.id }, select: { id: true } });
  return f.id;
}

async function makeOrder(n: number, floristId: string, deliveryDate: Date): Promise<string> {
  const o = await prisma.order.create({
    data: {
      orderNumber: `${RUN}-${n}`,
      siteId,
      source: "Website",
      externalCreatedAt: deliveryDate,
      deliveryDate,
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
      floristTotal: "100.00",
      platform: "SHOPIFY",
      orderStatus: "DELIVERED",
      currentFloristId: floristId,
      priceMode: "AUTO",
    },
    select: { id: true },
  });
  return o.id;
}

beforeAll(async () => {
  process.env.FINANCE_ACCRUAL_ENABLED = "true";
  process.env.FINANCE_ACCRUAL_START_DATE = "2026-07-01";

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

  primaryId = await makeFlorist("Primary");
  secondaryId = await makeFlorist("Secondary");
  await setFinanceProfile({ floristId: primaryId, model: "PRIMARY", effectiveFrom: new Date("2026-07-01T00:00:00.000Z"), actor: OWNER });
  await setFinanceProfile({ floristId: secondaryId, model: "SECONDARY", effectiveFrom: new Date("2026-07-01T00:00:00.000Z"), actor: OWNER });

  // Ровно лимит заказов ОСНОВНОГО флориста, и все — раньше по дате, чем заказы
  // второстепенного. Так воспроизводится прод: первый тик целиком уходит на них.
  for (let i = 0; i < DISPATCH_LIMIT; i++) {
    await makeOrder(i, primaryId, new Date(JULY.getTime() + i * 60_000));
  }
  for (let i = 0; i < 5; i++) {
    secondaryOrderIds.push(await makeOrder(1000 + i, secondaryId, new Date("2026-07-25T00:00:00.000Z")));
  }
});

afterAll(async () => {
  await prisma.$executeRawUnsafe(`ALTER TABLE "LedgerEntry" DISABLE TRIGGER USER`);
  await prisma.ledgerEntry.deleteMany({ where: { floristId: { in: [primaryId, secondaryId] } } });
  await prisma.$executeRawUnsafe(`ALTER TABLE "LedgerEntry" ENABLE TRIGGER USER`);

  await prisma.outboxEvent.deleteMany({ where: { eventType: "finance.order.accrual" } });
  await prisma.financeAudit.deleteMany({ where: { userId: OWNER.userId } });
  await prisma.floristFinanceProfile.deleteMany({ where: { floristId: { in: [primaryId, secondaryId] } } });
  await prisma.order.deleteMany({ where: { siteId } });
  await prisma.florist.deleteMany({ where: { id: { in: [primaryId, secondaryId] } } });
  await prisma.site.deleteMany({ where: { id: siteId } });
  await prisma.user.deleteMany({ where: { email: { startsWith: RUN } } });
});

describe("диспетчер начислений", () => {
  it("первый тик забирает лимит и не ставит задачи повторно", async () => {
    const first = await dispatchFinanceAccruals(prisma);
    expect(first.enqueued).toBe(DISPATCH_LIMIT);

    // Второй вызов подряд не создаёт дублей по уже поставленным заказам.
    const events = await prisma.outboxEvent.count({ where: { eventType: "finance.order.accrual" } });
    expect(events).toBe(DISPATCH_LIMIT);
  });

  it("второй тик доходит до заказов, которые не влезли в лимит", async () => {
    const second = await dispatchFinanceAccruals(prisma);
    expect(second.enqueued).toBe(secondaryOrderIds.length);

    // Каждый заказ второстепенного флориста получил свою задачу.
    for (const id of secondaryOrderIds) {
      const ev = await prisma.outboxEvent.findUnique({ where: { idempotencyKey: financeAccrualKey(id) } });
      expect(ev, `нет задачи для заказа ${id}`).not.toBeNull();
    }
  });

  it("третий тик ничего не создаёт: набор кандидатов исчерпан", async () => {
    const third = await dispatchFinanceAccruals(prisma);
    expect(third.enqueued).toBe(0);

    const total = await prisma.outboxEvent.count({ where: { eventType: "finance.order.accrual" } });
    expect(total).toBe(DISPATCH_LIMIT + secondaryOrderIds.length);
  });

  it("при закрытом гейте не ставит ничего", async () => {
    process.env.FINANCE_ACCRUAL_ENABLED = "false";
    const r = await dispatchFinanceAccruals(prisma);
    expect(r).toEqual({ selected: 0, enqueued: 0, skipped: "FINANCE_ACCRUAL_ENABLED=false" });
    process.env.FINANCE_ACCRUAL_ENABLED = "true";
  });
});
