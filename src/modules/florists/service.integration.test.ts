import { describe, it, expect, beforeAll, afterAll } from "vitest";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { createFlorist, updateFlorist, FloristValidationError } from "./service";
import { getSitePriorityFloristIds } from "@/modules/assignments/service";

const RUN = Date.now();
const email = (s: string) => `flo-${RUN}-${s}@test.local`;
let siteId = "";
const createdUserIds: string[] = [];
const orderIds: string[] = [];

async function makeFlorist(tag: string, over: Partial<{ name: string; phone: string; password: string; active: boolean }> = {}) {
  const r = await createFlorist(prisma, { name: over.name ?? `Florist ${tag}`, email: email(tag), phone: over.phone ?? "3105550100", password: over.password ?? "secret123", active: over.active });
  createdUserIds.push(r.userId);
  return r;
}

async function makeOrderWithAssignment(floristId: string): Promise<string> {
  const order = await prisma.order.create({
    data: {
      orderNumber: `#FLO-${RUN}-${Math.random().toString(36).slice(2, 7)}`,
      site: { connect: { id: siteId } }, platform: "WOOCOMMERCE", source: "test",
      externalCreatedAt: new Date(), deliveryDate: new Date(), deliveryWindow: "12:00 – 16:00",
      senderName: "S", senderPhone: "+13105550001", recipientName: "R", recipientPhone: "+13105550002",
      addressLine: "1 A St", city: "LA", zip: "90001",
      itemsTotal: new Prisma.Decimal(100), customerTotal: new Prisma.Decimal(115), paymentStatus: "PAID", orderStatus: "ASSIGNED",
      currentFlorist: { connect: { id: floristId } },
      assignments: { create: { florist: { connect: { id: floristId } }, state: "ASSIGNED", priceMode: "AUTO", floristTotalSnapshot: new Prisma.Decimal(50) } },
    },
    select: { id: true },
  });
  orderIds.push(order.id);
  return order.id;
}

beforeAll(async () => {
  const site = await prisma.site.create({ data: { name: `FLO Site ${RUN}`, shortName: `FLO${RUN % 100000}`, platform: "WOOCOMMERCE" } });
  siteId = site.id;
});
afterAll(async () => {
  await prisma.order.deleteMany({ where: { id: { in: orderIds } } }); // каскадом assignments
  await prisma.siteFloristPriority.deleteMany({ where: { siteId } });
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } }); // каскадом florist
  await prisma.site.deleteMany({ where: { id: siteId } });
});

describe("florists/service — создание и редактирование", () => {
  it("1) создание флориста → User(FLORIST, active, hash) + Florist(active, MAKER_ONLY); телефон нормализован", async () => {
    const { floristId, userId } = await makeFlorist("1", { phone: "310 555 0111" });
    const user = await prisma.user.findUnique({ where: { id: userId } });
    const florist = await prisma.florist.findUnique({ where: { id: floristId } });
    expect(user).toMatchObject({ role: "FLORIST", email: email("1"), active: true, name: "Florist 1" });
    expect(user!.phone).toBe("+13105550111"); // toE164
    expect(user!.passwordHash).not.toBe("secret123"); // захэширован
    expect(await bcrypt.compare("secret123", user!.passwordHash)).toBe(true);
    expect(florist).toMatchObject({ active: true, financeVisibility: "MAKER_ONLY" });
  });

  it("2) дубликат email → FloristValidationError", async () => {
    await makeFlorist("2");
    await expect(createFlorist(prisma, { name: "Dup", email: email("2"), password: "secret123" }))
      .rejects.toMatchObject({ name: "FloristValidationError", reason: "duplicate_email" });
  });

  it("3) дубликат login (=email) не создаёт второго пользователя", async () => {
    await makeFlorist("3");
    await expect(createFlorist(prisma, { name: "Dup login", email: email("3").toUpperCase(), password: "secret123" }))
      .rejects.toBeInstanceOf(FloristValidationError); // email нормализуется в lower → тот же логин
    expect(await prisma.user.count({ where: { email: email("3") } })).toBe(1);
  });

  it("4) изменение имени", async () => {
    const { floristId, userId } = await makeFlorist("4");
    await updateFlorist(prisma, floristId, { name: "New Name" });
    expect((await prisma.user.findUnique({ where: { id: userId } }))!.name).toBe("New Name");
  });

  it("5) изменение email (логина)", async () => {
    const { floristId, userId } = await makeFlorist("5");
    const newEmail = email("5-changed");
    await updateFlorist(prisma, floristId, { email: newEmail });
    expect((await prisma.user.findUnique({ where: { id: userId } }))!.email).toBe(newEmail);
    createdUserIds.push(userId); // тот же userId, уже в списке — ок
  });

  it("6) изменение телефона (нормализуется)", async () => {
    const { floristId, userId } = await makeFlorist("6");
    await updateFlorist(prisma, floristId, { phone: "(310) 555-0166" });
    expect((await prisma.user.findUnique({ where: { id: userId } }))!.phone).toBe("+13105550166");
  });

  it("7) изменение пароля → hash меняется, новый пароль валиден", async () => {
    const { floristId, userId } = await makeFlorist("7");
    const before = (await prisma.user.findUnique({ where: { id: userId } }))!.passwordHash;
    await updateFlorist(prisma, floristId, { password: "brandnew99" });
    const after = (await prisma.user.findUnique({ where: { id: userId } }))!.passwordHash;
    expect(after).not.toBe(before);
    expect(await bcrypt.compare("brandnew99", after)).toBe(true);
  });

  it("8) деактивированный флорист исключается из auto-assignment", async () => {
    const { floristId } = await makeFlorist("8");
    await prisma.siteFloristPriority.create({ data: { siteId, floristId, position: 0 } });
    expect(await getSitePriorityFloristIds(siteId)).toContain(floristId);
    await updateFlorist(prisma, floristId, { active: false });
    expect(await getSitePriorityFloristIds(siteId)).not.toContain(floristId);
  });

  it("9) деактивация не трогает историю назначений (Order/OrderAssignment сохраняются)", async () => {
    const { floristId } = await makeFlorist("9");
    const orderId = await makeOrderWithAssignment(floristId);
    await updateFlorist(prisma, floristId, { active: false });
    expect(await prisma.orderAssignment.count({ where: { orderId, floristId } })).toBe(1);
    expect(await prisma.order.findUnique({ where: { id: orderId }, select: { currentFloristId: true } })).toMatchObject({ currentFloristId: floristId });
    expect(await prisma.florist.findUnique({ where: { id: floristId }, select: { active: true } })).toMatchObject({ active: false });
  });
});
