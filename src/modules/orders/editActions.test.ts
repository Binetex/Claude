import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Ролевые гварды единого действия saveOrderBlock (мок-слой, без БД):
 *  - редактор = OWNER/CALL_CENTER/FLORIST (requireOrderEditor);
 *  - флорист может править ТОЛЬКО назначенный ему заказ (иначе forbidden), не трогая сервис;
 *  - финансы/назначение сюда не входят вовсе (нет таких блоков);
 *  - побочные эффекты (Shopify sync / re-plan) вызываются по блоку только при успехе.
 */

const requireOrderEditor = vi.fn();
const findUnique = vi.fn();
const updateOrderBlock = vi.fn();
const syncOrderToShopify = vi.fn(async () => {});
const onOrderDeliveryChangeSafe = vi.fn(async () => {});

vi.mock("@/lib/rbac", () => ({ requireOrderEditor: () => requireOrderEditor() }));
vi.mock("@/lib/db", () => ({ prisma: { order: { findUnique: (a: unknown) => findUnique(a) } } }));
vi.mock("./updateOrderBlock", () => ({ updateOrderBlock: (a: unknown) => updateOrderBlock(a) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/integrations/shopify/pushUpdate", () => ({ syncOrderToShopify: (id: string) => syncOrderToShopify(id) }));
vi.mock("@/integrations/delivery/burq/scheduleService", () => ({ onOrderDeliveryChangeSafe: (p: unknown, id: string) => onOrderDeliveryChangeSafe(p, id) }));

import { saveOrderBlock } from "./editActions";

beforeEach(() => {
  requireOrderEditor.mockReset();
  findUnique.mockReset();
  updateOrderBlock.mockReset();
  syncOrderToShopify.mockClear();
  onOrderDeliveryChangeSafe.mockClear();
  updateOrderBlock.mockResolvedValue({ status: "ok", updatedAt: "2026-07-21T12:00:00.000Z" });
});

describe("saveOrderBlock — call-center", () => {
  it("редактирует контакты и запускает Shopify sync + re-plan", async () => {
    requireOrderEditor.mockResolvedValue({ id: "u-cc", role: "CALL_CENTER", floristId: null });
    const res = await saveOrderBlock("o1", "contacts", "v0", { recipientName: "X" });
    expect(res.status).toBe("ok");
    expect(findUnique).not.toHaveBeenCalled(); // проверка владения только для флориста
    expect(updateOrderBlock).toHaveBeenCalledTimes(1);
    expect(syncOrderToShopify).toHaveBeenCalledWith("o1");
    expect(onOrderDeliveryChangeSafe).toHaveBeenCalled();
  });
});

describe("saveOrderBlock — owner", () => {
  it("меняет статус без побочных эффектов доставки", async () => {
    requireOrderEditor.mockResolvedValue({ id: "u-o", role: "OWNER", floristId: null });
    await saveOrderBlock("o1", "status", "v0", { orderStatus: "READY" });
    expect(updateOrderBlock).toHaveBeenCalledTimes(1);
    expect(syncOrderToShopify).not.toHaveBeenCalled();
    expect(onOrderDeliveryChangeSafe).not.toHaveBeenCalled();
  });
});

describe("saveOrderBlock — florist ownership", () => {
  it("свой заказ (currentFloristId совпадает) → редактирует", async () => {
    requireOrderEditor.mockResolvedValue({ id: "u-f", role: "FLORIST", floristId: "f1" });
    findUnique.mockResolvedValue({ currentFloristId: "f1" });
    const res = await saveOrderBlock("o1", "cardNote", "v0", { cardMessage: "hi" });
    expect(res.status).toBe("ok");
    expect(updateOrderBlock).toHaveBeenCalledTimes(1);
  });

  it("ЧУЖОЙ заказ → forbidden, сервис не вызывается", async () => {
    requireOrderEditor.mockResolvedValue({ id: "u-f", role: "FLORIST", floristId: "f1" });
    findUnique.mockResolvedValue({ currentFloristId: "f2" });
    const res = await saveOrderBlock("o1", "contacts", "v0", { recipientName: "X" });
    expect(res).toEqual({ status: "forbidden" });
    expect(updateOrderBlock).not.toHaveBeenCalled();
    expect(syncOrderToShopify).not.toHaveBeenCalled();
  });

  it("флорист без профиля (floristId=null) → forbidden", async () => {
    requireOrderEditor.mockResolvedValue({ id: "u-f", role: "FLORIST", floristId: null });
    findUnique.mockResolvedValue({ currentFloristId: "f1" });
    const res = await saveOrderBlock("o1", "status", "v0", { orderStatus: "READY" });
    expect(res).toEqual({ status: "forbidden" });
    expect(updateOrderBlock).not.toHaveBeenCalled();
  });
});
