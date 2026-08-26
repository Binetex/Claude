/**
 * Сроки воронки и очередь оператора. Требует живой БД в DATABASE_URL.
 *
 * Отправка замокана: здесь проверяется не транспорт, а то, что запрос вовремя уходит в «обещал
 * и забыл», напоминание отправляется РОВНО ОДИН раз, а очередь собирается по сроку — включая
 * просроченные вчерашние, которые иначе выпали бы из работы навсегда.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

const sent: string[] = [];
vi.mock("./sendLink", () => ({
  sendReviewLinkAndRecord: vi.fn(async (_db: unknown, input: { requestId: string }) => {
    sent.push(input.requestId);
    return { ok: true as const, channel: "SMS" as const };
  }),
}));

import { prisma } from "@/lib/db";
import { processPromisedDeadlines } from "./deadlines";
import { createReviewRequest, recordPromised } from "./requests";
import { listToday, listWaiting, queueCounts } from "./queue";

const RUN = `rdl-${Date.now()}`;
let siteId = "";
let actor = { userId: "" };
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
      zip: "90210",
      itemsTotal: "100.00",
      customerTotal: "100.00",
    },
  });
  orderIds.push(order.id);
  return order.id;
}

/** Запрос, у которого срок обещания уже прошёл. */
async function overduePromise(daysAgo = 1) {
  const { id } = await createReviewRequest(prisma, await makeOrder(), actor);
  await recordPromised(prisma, id, actor);
  await prisma.orderReviewRequest.update({
    where: { id },
    data: { nextActionAt: new Date(Date.now() - daysAgo * 86_400_000) },
  });
  return id;
}

beforeAll(async () => {
  const site = await prisma.site.create({
    data: { name: `${RUN}-site`, shortName: "RDL", platform: "SHOPIFY", connectionStatus: "CONNECTED" },
  });
  siteId = site.id;
  const user = await prisma.user.create({
    data: { name: "Оператор", email: `${RUN}@example.com`, role: "CALL_CENTER", passwordHash: "x" },
  });
  actor = { userId: user.id };
});

beforeEach(async () => {
  sent.length = 0;
  await prisma.orderReviewRequest.deleteMany({ where: { order: { siteId } } });
});

afterAll(async () => {
  await prisma.orderReviewRequest.deleteMany({ where: { order: { siteId } } }).catch(() => {});
  await prisma.order.deleteMany({ where: { siteId } }).catch(() => {});
  await prisma.user.delete({ where: { id: actor.userId } }).catch(() => {});
  await prisma.site.delete({ where: { id: siteId } }).catch(() => {});
});

describe("обещал и забыл", () => {
  it("просроченное обещание уводит запрос в «забыл» и шлёт одно напоминание", async () => {
    const id = await overduePromise();

    const res = await processPromisedDeadlines(prisma);
    expect(res).toMatchObject({ moved: 1, reminded: 1 });

    const row = await prisma.orderReviewRequest.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe("FORGOT");
    expect(row.remindedAt).not.toBeNull();
    // Срок снят: иначе запрос вечно висел бы в «сегодня» у оператора.
    expect(row.nextActionAt).toBeNull();
  });

  it("второй проход напоминание НЕ повторяет", async () => {
    // Повтор превратил бы напоминание в назойливость; отсекает сам статус.
    await overduePromise();
    await processPromisedDeadlines(prisma);
    const second = await processPromisedDeadlines(prisma);

    expect(second).toMatchObject({ checked: 0, moved: 0 });
    expect(sent).toHaveLength(1);
  });

  it("обещание, срок которого ещё не наступил, не трогается", async () => {
    const { id } = await createReviewRequest(prisma, await makeOrder(), actor);
    await recordPromised(prisma, id, actor);

    expect(await processPromisedDeadlines(prisma)).toMatchObject({ moved: 0 });
    expect((await prisma.orderReviewRequest.findUniqueOrThrow({ where: { id } })).status).toBe("PROMISED");
  });

  it("в журнале остаётся запись о напоминании", async () => {
    const id = await overduePromise();
    await processPromisedDeadlines(prisma);

    const kinds = await prisma.reviewRequestEvent.findMany({ where: { requestId: id }, select: { kind: true } });
    expect(kinds.map((k) => k.kind)).toContain("REMINDED");
  });
});

describe("очередь оператора", () => {
  it("новый запрос попадает в «сегодня»", async () => {
    const { id } = await createReviewRequest(prisma, await makeOrder(), actor);
    const today = await listToday();
    expect(today.map((c) => c.id)).toContain(id);
  });

  it("просроченный вчерашний остаётся в «сегодня», а не выпадает", async () => {
    // Срок в прошлом означает «пора было вчера», а не «запрос выбыл».
    const { id } = await createReviewRequest(prisma, await makeOrder(), actor);
    await prisma.orderReviewRequest.update({
      where: { id },
      data: { status: "CALLING", nextActionAt: new Date(Date.now() - 3 * 86_400_000) },
    });

    expect((await listToday()).map((c) => c.id)).toContain(id);
  });

  it("запрос, назначенный на сегодня вечером, виден уже утром", async () => {
    // Иначе оператор увидел бы его только к вечеру, когда звонить уже поздно.
    const { id } = await createReviewRequest(prisma, await makeOrder(), actor);
    const tonight = new Date();
    tonight.setHours(21, 0, 0, 0);
    await prisma.orderReviewRequest.update({ where: { id }, data: { status: "CALLING", nextActionAt: tonight } });

    const morning = new Date();
    morning.setHours(8, 0, 0, 0);
    expect((await listToday(morning)).map((c) => c.id)).toContain(id);
  });

  it("«обещал оставить» не висит у оператора: его срок — про напоминание, а не про звонок", async () => {
    // Иначе оператор звонил бы человеку, которому через час и так уйдёт напоминание, а запрос
    // стоял бы разом в «сегодня» и в «ждут ответа».
    const id = await overduePromise();

    expect((await listToday()).map((c) => c.id)).not.toContain(id);
    expect((await listWaiting()).map((c) => c.id)).toContain(id);
    expect((await queueCounts()).today).toBe(0);
  });

  it("ожидающий ответа не мешается в «сегодня»", async () => {
    const { id } = await createReviewRequest(prisma, await makeOrder(), actor);
    await prisma.orderReviewRequest.update({
      where: { id },
      data: { status: "LINK_SENT", nextActionAt: null, linkSentAt: new Date() },
    });

    expect((await listToday()).map((c) => c.id)).not.toContain(id);
    expect((await listWaiting()).map((c) => c.id)).toContain(id);
  });

  it("закрытый запрос не попадает ни в одну рабочую вкладку", async () => {
    const { id } = await createReviewRequest(prisma, await makeOrder(), actor);
    await prisma.orderReviewRequest.update({
      where: { id },
      data: { status: "CONFIRMED", nextActionAt: new Date(0), closedAt: new Date() },
    });

    const counts = await queueCounts();
    expect((await listToday()).map((c) => c.id)).not.toContain(id);
    expect(counts.today).toBe(0);
  });
});
