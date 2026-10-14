/**
 * Остаток по флористам на живой БД (одноразовая, `npm run test:db`): приход с флористом и
 * передача двумя строками с общим id пишутся и читаются так, как их читает «Приход и остаток».
 */
import { describe, it, expect, afterAll } from "vitest";
import { prisma } from "@/lib/db";
import { stockByFlorist, stockTotal } from "./stock";

const suffix = `stock-${Date.now()}`;
const ids = { users: [] as string[], florists: [] as string[], items: [] as string[] };

afterAll(async () => {
  await prisma.consumableItem.deleteMany({ where: { id: { in: ids.items } } }); // приход удалится каскадом
  await prisma.florist.deleteMany({ where: { id: { in: ids.florists } } });
  await prisma.user.deleteMany({ where: { id: { in: ids.users } } });
});

describe("приход и передача по флористам", () => {
  it("500 коробок Ольге, 200 из них — Насте", async () => {
    const florist = async (name: string) => {
      const user = await prisma.user.create({ data: { name, email: `${name}-${suffix}@t.local`, role: "FLORIST", passwordHash: "x" } });
      ids.users.push(user.id);
      const f = await prisma.florist.create({ data: { userId: user.id } });
      ids.florists.push(f.id);
      return f.id;
    };
    const olga = await florist("olga");
    const nastya = await florist("nastya");
    const box = (await prisma.consumableItem.create({ data: { name: `Box ${suffix}` } })).id;
    ids.items.push(box);

    const day = new Date("2026-10-14T00:00:00Z");
    await prisma.consumableReceipt.create({ data: { itemId: box, floristId: olga, day, quantity: 500, note: "из Китая" } });
    await prisma.consumableReceipt.createMany({
      data: [
        { itemId: box, floristId: olga, day, quantity: -200, transferId: `t-${suffix}` },
        { itemId: box, floristId: nastya, day, quantity: 200, transferId: `t-${suffix}` },
      ],
    });

    const rows = await prisma.consumableReceipt.findMany({
      where: { itemId: box },
      select: { itemId: true, floristId: true, transferId: true, day: true, quantity: true },
    });
    const stock = stockByFlorist(rows.map((r) => ({ ...r, day: r.day.toISOString().slice(0, 10) })), []);
    expect(stock.get(box)!.get(olga)!.left).toBe(300);
    expect(stock.get(box)!.get(nastya)!.left).toBe(200);
    expect(stockTotal(stock.get(box)).left).toBe(500);

    // Флориста удалили — приход не пропадает, а становится «без флориста».
    await prisma.florist.delete({ where: { id: nastya } });
    expect(await prisma.consumableReceipt.count({ where: { itemId: box, floristId: null } })).toBe(1);
  });
});
