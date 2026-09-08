import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { markOrderCommunicationsRead, suggestOrdersForCommunication, listOtherThreads, setThreadTopic, linkThreadToOrder } from "./communicationsService";

const suffix = `quosvc-${Date.now()}`;
let siteId: string;
const orderIds: string[] = [];
const commIds: string[] = [];
let seq = 6000;
const uniquePhone = () => `+1310556${(seq++).toString().padStart(4, "0")}`;

async function makeOrder(senderPhone: string, recipientPhone: string): Promise<string> {
  const o = await prisma.order.create({
    data: {
      orderNumber: `#SVC-${suffix}-${Math.random().toString(36).slice(2, 8)}`, site: { connect: { id: siteId } },
      platform: "WOOCOMMERCE", source: "Website", externalCreatedAt: new Date(), deliveryDate: new Date(), deliveryWindow: "x",
      senderName: "B", senderPhone, recipientName: "R", recipientPhone, addressLine: "1", city: "SM", zip: "90401",
      itemsTotal: new Prisma.Decimal(1), customerTotal: new Prisma.Decimal(1), paymentStatus: "PAID", orderStatus: "CONFIRMED",
    }, select: { id: true },
  });
  orderIds.push(o.id);
  return o.id;
}
async function insertComm(over: Partial<Prisma.OrderCommunicationUncheckedCreateInput> & { externalPhoneNormalized: string }): Promise<string> {
  const c = await prisma.orderCommunication.create({
    data: {
      provider: "QUO", type: "SMS", direction: "INBOUND", status: "RECEIVED",
      externalPhone: over.externalPhoneNormalized, occurredAt: new Date(), ...over,
    }, select: { id: true },
  });
  commIds.push(c.id);
  return c.id;
}

beforeAll(async () => { siteId = (await prisma.site.create({ data: { name: `Svc ${suffix}`, shortName: "SVC", platform: "WOOCOMMERCE" } })).id; });
afterAll(async () => {
  await prisma.orderCommunication.deleteMany({ where: { id: { in: commIds } } });
  await prisma.order.deleteMany({ where: { siteId } });
  await prisma.site.deleteMany({ where: { id: siteId } });
});

describe("communicationsService", () => {
  it("markOrderCommunicationsRead помечает входящие SMS и пропущенные звонки, не трогая прочее (§16.3)", async () => {
    const orderId = await makeOrder(uniquePhone(), uniquePhone());
    const inSms = await insertComm({ orderId, type: "SMS", direction: "INBOUND", status: "RECEIVED", externalPhoneNormalized: uniquePhone() });
    const missed = await insertComm({ orderId, type: "CALL", direction: "INBOUND", status: "MISSED", externalPhoneNormalized: uniquePhone() });
    const outSms = await insertComm({ orderId, type: "SMS", direction: "OUTBOUND", status: "DELIVERED", externalPhoneNormalized: uniquePhone() });
    const answered = await insertComm({ orderId, type: "CALL", direction: "INBOUND", status: "COMPLETED", externalPhoneNormalized: uniquePhone() });

    const count = await markOrderCommunicationsRead(prisma, orderId);
    expect(count).toBe(2);
    expect((await prisma.orderCommunication.findUnique({ where: { id: inSms } }))!.readAt).toBeTruthy();
    expect((await prisma.orderCommunication.findUnique({ where: { id: missed } }))!.readAt).toBeTruthy();
    expect((await prisma.orderCommunication.findUnique({ where: { id: outSms } }))!.readAt).toBeNull();
    expect((await prisma.orderCommunication.findUnique({ where: { id: answered } }))!.readAt).toBeNull();

    // Повторный вызов — идемпотентно ничего нового.
    expect(await markOrderCommunicationsRead(prisma, orderId)).toBe(0);
  });

  it("в раздел попадают только непривязанные и неигнорированные события", async () => {
    const p = uniquePhone();
    const linkedPhone = uniquePhone();
    await insertComm({ orderId: await makeOrder(p, uniquePhone()), externalPhoneNormalized: linkedPhone, providerPhoneNumberId: `PN-${suffix}-sel` });
    const freePhone = uniquePhone();
    await insertComm({ externalPhoneNormalized: freePhone, providerPhoneNumberId: `PN-${suffix}-sel`, type: "SMS", direction: "INBOUND" });
    const ignoredPhone = uniquePhone();
    await insertComm({ externalPhoneNormalized: ignoredPhone, providerPhoneNumberId: `PN-${suffix}-sel`, ignoredAt: new Date() });

    const { threads } = await listOtherThreads(prisma, { take: 2000 });
    const phones = threads.map((t) => t.phone);
    expect(phones).toContain(freePhone);
    expect(phones).not.toContain(linkedPhone); // уже в заказе
    expect(phones).not.toContain(ignoredPhone); // скрыт
  });

  it("события без номера собеседника в переписки не собираются", async () => {
    await insertComm({ externalPhoneNormalized: "", externalPhone: "", providerPhoneNumberId: `PN-${suffix}-empty` });
    const { threads } = await listOtherThreads(prisma, { take: 2000 });
    expect(threads.map((t) => t.phone)).not.toContain("");
  });

  it("listOtherThreads: события одного номера и магазина склеиваются в одну переписку", async () => {
    const phone = uniquePhone();
    const pn = `PN-${suffix}-a`;
    const t0 = new Date(Date.now() - 3 * 3600_000);
    await insertComm({ externalPhoneNormalized: phone, providerPhoneNumberId: pn, type: "SMS", direction: "INBOUND", messageText: "Can I place an order for today?", occurredAt: t0 });
    await insertComm({ externalPhoneNormalized: phone, providerPhoneNumberId: pn, type: "SMS", direction: "OUTBOUND", status: "DELIVERED", messageText: "Sure!", occurredAt: new Date(t0.getTime() + 60_000) });
    await insertComm({ externalPhoneNormalized: phone, providerPhoneNumberId: pn, type: "CALL", direction: "INBOUND", status: "MISSED", messageText: null, occurredAt: new Date(t0.getTime() + 120_000) });

    const { threads } = await listOtherThreads(prisma, { take: 2000 });
    const mine = threads.find((t) => t.phone === phone)!;
    expect(mine).toBeTruthy();
    expect(mine.smsCount).toBe(2);
    expect(mine.callCount).toBe(1);
    // Категория — по ВСЕЙ переписке, а не по последнему событию (последнее здесь без текста).
    expect(mine.topic).toBe("NEW_ORDER");
    expect(mine.topicIsManual).toBe(false);
    expect(mine.waitingForUs).toBe(true); // последнее событие входящее
    expect(mine.callsOnly).toBe(false);
  });

  it("listOtherThreads: один номер в двух магазинах — две разные переписки", async () => {
    const phone = uniquePhone();
    await insertComm({ externalPhoneNormalized: phone, providerPhoneNumberId: `PN-${suffix}-x`, messageText: "hi" });
    await insertComm({ externalPhoneNormalized: phone, providerPhoneNumberId: `PN-${suffix}-y`, messageText: "hi" });
    const threads = (await listOtherThreads(prisma, { take: 2000 })).threads.filter((t) => t.phone === phone);
    expect(threads).toHaveLength(2);
  });

  it("listOtherThreads: переписка только из звонков помечается callsOnly", async () => {
    const phone = uniquePhone();
    const pn = `PN-${suffix}-calls`;
    await insertComm({ externalPhoneNormalized: phone, providerPhoneNumberId: pn, type: "CALL", direction: "INBOUND", status: "MISSED", messageText: null });
    await insertComm({ externalPhoneNormalized: phone, providerPhoneNumberId: pn, type: "CALL", direction: "INBOUND", status: "MISSED", messageText: null });
    const mine = (await listOtherThreads(prisma, { take: 2000 })).threads.find((t) => t.phone === phone)!;
    expect(mine.callsOnly).toBe(true);
    expect(mine.callCount).toBe(2);
    expect(mine.topic).toBe("OTHER");
  });

  it("setThreadTopic перебивает правило и не трогает события, привязанные к заказу", async () => {
    const phone = uniquePhone();
    const pn = `PN-${suffix}-manual`;
    const orderId = await makeOrder(phone, uniquePhone());
    const linked = await insertComm({ orderId, externalPhoneNormalized: phone, providerPhoneNumberId: pn, messageText: "Can I place an order?" });
    await insertComm({ externalPhoneNormalized: phone, providerPhoneNumberId: pn, messageText: "Can I place an order?" });

    expect((await listOtherThreads(prisma, { take: 2000 })).threads.find((t) => t.phone === phone)!.topic).toBe("NEW_ORDER");

    const changed = await setThreadTopic(prisma, { phoneE164: phone, providerPhoneNumberId: pn, topic: "SPAM" });
    expect(changed).toBe(1); // только непривязанное событие

    const mine = (await listOtherThreads(prisma, { take: 2000 })).threads.find((t) => t.phone === phone)!;
    expect(mine.topic).toBe("SPAM");
    expect(mine.topicIsManual).toBe(true);
    // Событие в заказе метку не получило — иначе «Спам» сел бы на живую переписку по заказу.
    expect((await prisma.orderCommunication.findUnique({ where: { id: linked } }))!.topicManual).toBeNull();

    // Снятие ручной метки возвращает переписку под правило.
    await setThreadTopic(prisma, { phoneE164: phone, providerPhoneNumberId: pn, topic: null });
    const back = (await listOtherThreads(prisma, { take: 2000 })).threads.find((t) => t.phone === phone)!;
    expect(back.topic).toBe("NEW_ORDER");
    expect(back.topicIsManual).toBe(false);
  });

  it("setThreadTopic с providerPhoneNumberId=null метит ТОЛЬКО переписку без магазина", async () => {
    // Самый опасный случай: в Prisma `where: { field: null }` означает «IS NULL», а не
    // «условие не задано». Если бы условие игнорировалось, «Спам» уехал бы на переписки того
    // же номера во всех магазинах сразу.
    const phone = uniquePhone();
    const withStore = await insertComm({ externalPhoneNormalized: phone, providerPhoneNumberId: `PN-${suffix}-real`, messageText: "hi" });
    const noStore = await insertComm({ externalPhoneNormalized: phone, providerPhoneNumberId: null, messageText: "hi" });

    const changed = await setThreadTopic(prisma, { phoneE164: phone, providerPhoneNumberId: null, topic: "SPAM" });
    expect(changed).toBe(1);
    expect((await prisma.orderCommunication.findUnique({ where: { id: noStore } }))!.topicManual).toBe("SPAM");
    expect((await prisma.orderCommunication.findUnique({ where: { id: withStore } }))!.topicManual).toBeNull();
  });

  it("linkThreadToOrder переносит В ЗАКАЗ ВСЮ переписку, а не одно событие (§16.6)", async () => {
    const phone = uniquePhone();
    const pn = `PN-${suffix}-link`;
    const orderId = await makeOrder(uniquePhone(), uniquePhone());
    await insertComm({ externalPhoneNormalized: phone, providerPhoneNumberId: pn, messageText: "hi" });
    await insertComm({ externalPhoneNormalized: phone, providerPhoneNumberId: pn, type: "CALL", status: "MISSED", messageText: null });
    // Событие того же номера, но ЧУЖОГО магазина — трогать нельзя.
    const other = await insertComm({ externalPhoneNormalized: phone, providerPhoneNumberId: `PN-${suffix}-other`, messageText: "hi" });

    const r = await linkThreadToOrder(prisma, { phoneE164: phone, providerPhoneNumberId: pn, orderId });
    expect(r).toMatchObject({ ok: true, linked: 2 });
    expect((await prisma.orderCommunication.findUnique({ where: { id: other } }))!.orderId).toBeNull();

    // Переписка ушла из раздела целиком.
    const left = (await listOtherThreads(prisma, { take: 2000 })).threads.filter((t) => t.phone === phone && t.providerPhoneNumberId === pn);
    expect(left).toHaveLength(0);
  });

  it("linkThreadToOrder на несуществующем заказе ничего не трогает", async () => {
    const phone = uniquePhone();
    const pn = `PN-${suffix}-noorder`;
    const id = await insertComm({ externalPhoneNormalized: phone, providerPhoneNumberId: pn, messageText: "hi" });
    const r = await linkThreadToOrder(prisma, { phoneE164: phone, providerPhoneNumberId: pn, orderId: "нет-такого" });
    expect(r).toMatchObject({ ok: false, linked: 0, reason: "order_not_found" });
    expect((await prisma.orderCommunication.findUnique({ where: { id } }))!.orderId).toBeNull();
  });

  it("suggestOrdersForCommunication предлагает заказ по номеру", async () => {
    const phone = uniquePhone();
    const orderId = await makeOrder(phone, uniquePhone());
    const commId = await insertComm({ externalPhoneNormalized: phone });
    const sugg = await suggestOrdersForCommunication(prisma, commId);
    expect(sugg.map((s) => s.orderId)).toContain(orderId);
    expect(sugg.find((s) => s.orderId === orderId)?.role).toBe("CUSTOMER");
  });
});
