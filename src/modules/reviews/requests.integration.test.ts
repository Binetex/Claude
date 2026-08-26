/**
 * Воронка запроса отзыва. Требует живой БД в DATABASE_URL.
 *
 * Проверяется то, из-за чего воронка молча теряла бы работу: очередь оператора строится по
 * СРОКУ, а не по статусу; каждый переход оставляет след в журнале; повторная пометка не заводит
 * второй запрос (иначе клиенту звонят дважды); а точка и ссылка фиксируются снимком, потому что
 * разметку ZIP правят, а «куда мы отправили этого клиента» обязано остаться правдой.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { prisma } from "@/lib/db";
import {
  createReviewRequest,
  recordNoAnswer,
  recordTalked,
  recordPromised,
  recordClaimed,
  confirmReview,
  declineReview,
  reopenReview,
  changeRequestLocation,
  resolveReviewSettings,
  DEFAULT_REVIEW_SETTINGS,
} from "./requests";

const RUN = `rreq-${Date.now()}`;
let siteId = "";
let otherSiteId = "";
let actor = { userId: "" };
const orderIds: string[] = [];

async function makeOrder(zip = "90210") {
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
      zip,
      itemsTotal: "100.00",
      customerTotal: "100.00",
    },
  });
  orderIds.push(order.id);
  return order.id;
}

const read = (id: string) => prisma.orderReviewRequest.findUniqueOrThrow({ where: { id } });
const kinds = (id: string) =>
  prisma.reviewRequestEvent.findMany({ where: { requestId: id }, orderBy: { createdAt: "asc" }, select: { kind: true } });

beforeAll(async () => {
  const [site, other] = await Promise.all([
    prisma.site.create({ data: { name: `${RUN}-site`, shortName: "RRQ", platform: "SHOPIFY", connectionStatus: "CONNECTED" } }),
    prisma.site.create({ data: { name: `${RUN}-other`, shortName: "RRO", platform: "SHOPIFY", connectionStatus: "CONNECTED" } }),
  ]);
  siteId = site.id;
  otherSiteId = other.id;
  const user = await prisma.user.create({
    data: { name: "Оператор", email: `${RUN}@example.com`, role: "CALL_CENTER", passwordHash: "x" },
  });
  actor = { userId: user.id };
});

beforeEach(async () => {
  await prisma.orderReviewRequest.deleteMany({ where: { order: { siteId } } });
  await prisma.googleLocation.deleteMany({ where: { siteId: { in: [siteId, otherSiteId] } } });
  await prisma.siteReviewSettings.deleteMany({ where: { siteId } });
});

afterAll(async () => {
  await prisma.orderReviewRequest.deleteMany({ where: { order: { siteId } } }).catch(() => {});
  await prisma.googleLocation.deleteMany({ where: { siteId: { in: [siteId, otherSiteId] } } }).catch(() => {});
  await prisma.siteReviewSettings.deleteMany({ where: { siteId } }).catch(() => {});
  await prisma.order.deleteMany({ where: { siteId } }).catch(() => {});
  await prisma.user.delete({ where: { id: actor.userId } }).catch(() => {});
  await prisma.site.deleteMany({ where: { id: { in: [siteId, otherSiteId] } } }).catch(() => {});
});

describe("создание запроса", () => {
  it("подставляет точку по ZIP и фиксирует ссылку снимком", async () => {
    const loc = await prisma.googleLocation.create({
      data: { siteId, name: "Beverly", reviewUrl: "https://g.page/r/bh/review", zips: ["90210"] },
    });
    const orderId = await makeOrder("90210");

    const { id, created } = await createReviewRequest(prisma, orderId, actor);
    expect(created).toBe(true);
    const row = await read(id);
    expect(row.locationId).toBe(loc.id);
    expect(row.reviewUrlSnapshot).toBe("https://g.page/r/bh/review");
    expect(row.status).toBe("NEW");
    // Сразу в очередь оператора: пометка владельца и означает «звонить».
    expect(row.nextActionAt).not.toBeNull();
  });

  it("снимок ссылки переживает удаление точки", async () => {
    // Разметку правят, точки закрывают — но «куда мы отправили этого клиента» должно остаться.
    const loc = await prisma.googleLocation.create({
      data: { siteId, name: "Beverly", reviewUrl: "https://g.page/r/bh/review", zips: ["90210"] },
    });
    const { id } = await createReviewRequest(prisma, await makeOrder("90210"), actor);
    await prisma.googleLocation.delete({ where: { id: loc.id } });

    const row = await read(id);
    expect(row.locationId).toBeNull();
    expect(row.reviewUrlSnapshot).toBe("https://g.page/r/bh/review");
  });

  it("повторная пометка не заводит второй запрос", async () => {
    // Второй запрос означал бы два звонка одному клиенту по одному заказу.
    const orderId = await makeOrder();
    const first = await createReviewRequest(prisma, orderId, actor);
    const second = await createReviewRequest(prisma, orderId, actor);

    expect(second).toEqual({ id: first.id, created: false });
    expect(await prisma.orderReviewRequest.count({ where: { orderId } })).toBe(1);
  });

  it("заказ без точек и без ссылки магазина запрос всё равно получает", async () => {
    // Просить отзыв можно голосом; отказ здесь потерял бы решение владельца из-за пустого
    // справочника.
    const { id } = await createReviewRequest(prisma, await makeOrder("99999"), actor);
    const row = await read(id);
    expect(row.reviewUrlSnapshot).toBeNull();
    expect(row.status).toBe("NEW");
  });
});

describe("звонки", () => {
  it("первая неудача возвращает запрос в очередь на завтра", async () => {
    const { id } = await createReviewRequest(prisma, await makeOrder(), actor);
    const res = await recordNoAnswer(prisma, id, actor);

    expect(res).toMatchObject({ attempts: 1, exhausted: false });
    const row = await read(id);
    expect(row.status).toBe("CALLING");
    expect(row.nextActionAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it("вторая неудача исчерпывает попытки и снимает запрос с очереди оператора", async () => {
    // Дальше работает отправка ссылки, звонить больше незачем.
    const { id } = await createReviewRequest(prisma, await makeOrder(), actor);
    await recordNoAnswer(prisma, id, actor);
    const res = await recordNoAnswer(prisma, id, actor);

    expect(res).toMatchObject({ attempts: 2, exhausted: true });
    expect((await read(id)).nextActionAt).toBeNull();
  });

  it("число попыток берётся из настроек магазина", async () => {
    await prisma.siteReviewSettings.create({ data: { siteId, maxCallAttempts: 3 } });
    const { id } = await createReviewRequest(prisma, await makeOrder(), actor);

    expect((await recordNoAnswer(prisma, id, actor)).exhausted).toBe(false);
    expect((await recordNoAnswer(prisma, id, actor)).exhausted).toBe(false);
    expect((await recordNoAnswer(prisma, id, actor)).exhausted).toBe(true);
  });
});

describe("движение по воронке", () => {
  it("обещание ставит срок напоминания, а не срок звонка", async () => {
    const { id } = await createReviewRequest(prisma, await makeOrder(), actor);
    await recordPromised(prisma, id, actor);

    const row = await read(id);
    expect(row.status).toBe("PROMISED");
    expect(row.promisedAt).not.toBeNull();
    const days = (row.nextActionAt!.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(13);
    expect(days).toBeLessThan(15);
  });

  it("«клиент сказал, что оставил» уводит на проверку и снимает срок", async () => {
    const { id } = await createReviewRequest(prisma, await makeOrder(), actor);
    await recordClaimed(prisma, id, actor);

    const row = await read(id);
    expect(row.status).toBe("READY_TO_CHECK");
    expect(row.nextActionAt).toBeNull();
  });

  it("подтверждение помнит, чем именно засчитан отзыв", async () => {
    // По слову клиента и найденное в Google не должны выглядеть одинаково достоверными.
    const { id } = await createReviewRequest(prisma, await makeOrder(), actor);
    await confirmReview(prisma, id, "MANUAL", actor);

    const row = await read(id);
    expect(row.status).toBe("CONFIRMED");
    expect(row.confirmedVia).toBe("MANUAL");
    expect(row.confirmedByUserId).toBe(actor.userId);
    expect(row.closedAt).not.toBeNull();
  });

  it("закрытый запрос можно вернуть в работу", async () => {
    const { id } = await createReviewRequest(prisma, await makeOrder(), actor);
    await declineReview(prisma, id, actor);
    expect((await read(id)).status).toBe("DECLINED");

    await reopenReview(prisma, id, actor);
    const row = await read(id);
    expect(row.status).toBe("NEW");
    expect(row.closedAt).toBeNull();
    expect(row.nextActionAt).not.toBeNull();
  });
});

describe("журнал", () => {
  it("каждый переход оставляет след, и следы не затираются", async () => {
    const { id } = await createReviewRequest(prisma, await makeOrder(), actor);
    await recordNoAnswer(prisma, id, actor);
    await recordNoAnswer(prisma, id, actor);
    await recordTalked(prisma, id, actor);
    await recordPromised(prisma, id, actor);
    await confirmReview(prisma, id, "GOOGLE_MATCH", actor);

    expect((await kinds(id)).map((e) => e.kind)).toEqual([
      "CREATED",
      "CALL_NO_ANSWER",
      "CALL_NO_ANSWER",
      "CALL_TALKED",
      "PROMISED",
      "CONFIRMED",
    ]);
  });

  it("две неудачные попытки видны обе, а не одной строкой", async () => {
    const { id } = await createReviewRequest(prisma, await makeOrder(), actor);
    await recordNoAnswer(prisma, id, actor);
    await recordNoAnswer(prisma, id, actor);

    const details = await prisma.reviewRequestEvent.findMany({
      where: { requestId: id, kind: "CALL_NO_ANSWER" },
      orderBy: { createdAt: "asc" },
      select: { detailSafe: true },
    });
    expect(details.map((d) => d.detailSafe)).toEqual(["attempt=1", "attempt=2"]);
  });
});

describe("смена точки вручную", () => {
  it("точка своего магазина принимается и переписывает ссылку", async () => {
    const { id } = await createReviewRequest(prisma, await makeOrder("99999"), actor);
    const loc = await prisma.googleLocation.create({
      data: { siteId, name: "Culver", reviewUrl: "https://g.page/r/culver/review", zips: ["90232"] },
    });

    expect(await changeRequestLocation(prisma, id, loc.id, actor)).toEqual({ ok: true });
    const row = await read(id);
    expect(row.locationId).toBe(loc.id);
    expect(row.reviewUrlSnapshot).toBe("https://g.page/r/culver/review");
  });

  it("точка чужого магазина отвергается", async () => {
    // Иначе клиент ушёл бы писать отзыв не тому бизнесу.
    const { id } = await createReviewRequest(prisma, await makeOrder(), actor);
    const alien = await prisma.googleLocation.create({
      data: { siteId: otherSiteId, name: "Чужая", reviewUrl: "https://g.page/r/alien/review", zips: [] },
    });

    expect(await changeRequestLocation(prisma, id, alien.id, actor)).toMatchObject({ ok: false });
    expect((await read(id)).locationId).toBeNull();
  });
});

describe("настройки магазина", () => {
  it("без строки настроек работают значения по умолчанию", async () => {
    expect(await resolveReviewSettings(prisma, siteId)).toEqual(DEFAULT_REVIEW_SETTINGS);
  });
});
