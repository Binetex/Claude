import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import type { OutboxRecord } from "@/outbox/types";

const pushWooOrderPaid = vi.fn(async () => {});

vi.mock("./credentials", () => ({
  resolveWooCredentials: vi.fn(async () => ({ siteId: "s1", storeUrl: "https://shop.test" })),
}));
vi.mock("./statusPush", async (importOriginal) => ({
  // Предикат берём настоящий — тестируем реальное правило, а не его двойника.
  ...(await importOriginal<typeof import("./statusPush")>()),
  pushWooOrderPaid,
}));

const { buildWooStatusPushHandler } = await import("./statusPushHandler");

type OrderRow = {
  id: string; siteId: string; externalId: string | null; externalStatus: string | null;
  platform: string; orderNumber: string;
};

function prismaWith(order: OrderRow | null, push: boolean | null): PrismaClient {
  return {
    order: { findUnique: vi.fn(async () => order) },
    wooCommerceConnection: { findUnique: vi.fn(async () => (push === null ? null : { pushPaidStatusToWoo: push })) },
  } as unknown as PrismaClient;
}

const ORDER: OrderRow = {
  id: "o1", siteId: "s1", externalId: "20253", externalStatus: "airwallex-pending",
  platform: "WOOCOMMERCE", orderNumber: "THEFLOW-20253",
};

const REC = { payload: { orderId: "o1" } } as unknown as OutboxRecord;

beforeEach(() => pushWooOrderPaid.mockClear());

describe("запись статуса в магазин", () => {
  it("пишет processing по подтверждённой оплате", async () => {
    await buildWooStatusPushHandler(prismaWith(ORDER, true))(REC);
    expect(pushWooOrderPaid).toHaveBeenCalledWith(expect.objectContaining({ siteId: "s1" }), "20253");
  });

  it("снятая галочка останавливает УЖЕ стоящую в очереди задачу", async () => {
    // Иначе «выключить» не означало бы «прекратить писать»: задача, поставленная до снятия
    // галочки, всё равно записала бы в магазин.
    await buildWooStatusPushHandler(prismaWith(ORDER, false))(REC);
    expect(pushWooOrderPaid).not.toHaveBeenCalled();
  });

  it("не пишет, если магазин успел перевести заказ сам", async () => {
    await buildWooStatusPushHandler(prismaWith({ ...ORDER, externalStatus: "processing" }, true))(REC);
    expect(pushWooOrderPaid).not.toHaveBeenCalled();
  });

  it("не воскрешает отменённый заказ", async () => {
    await buildWooStatusPushHandler(prismaWith({ ...ORDER, externalStatus: "cancelled" }, true))(REC);
    expect(pushWooOrderPaid).not.toHaveBeenCalled();
  });

  it("молчит на заказе не из WooCommerce и на исчезнувшем заказе", async () => {
    await buildWooStatusPushHandler(prismaWith({ ...ORDER, platform: "SHOPIFY" }, true))(REC);
    await buildWooStatusPushHandler(prismaWith(null, true))(REC);
    expect(pushWooOrderPaid).not.toHaveBeenCalled();
  });

  it("ошибку магазина не глотает — outbox должен повторить", async () => {
    pushWooOrderPaid.mockRejectedValueOnce(new Error("503 from WordPress"));
    await expect(buildWooStatusPushHandler(prismaWith(ORDER, true))(REC)).rejects.toThrow("503");
  });
});
